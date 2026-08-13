import { getDb } from "../src/db";
import { recordDiscoveryResult } from "../src/db/queries/companies";
import { canonicalAdpRmUrl, normalizeAdpRmToken } from "../src/lib/ats/adpRecruitingManagement";

interface Row { organization_id: number; resolved_company_id: number; discovered_jobs_url: string; canonical_name: string }
interface Site { id?: string; domain?: string; orgoid?: string; isiClientId?: string; active?: boolean; isMyJobsEnabled?: boolean }
interface Promotion { row: Row; token: string; url: string }
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function followLegacyRedirect(start: URL): Promise<Response> {
  let url = start; const cookies = new Map<string, string>();
  for (let hop = 0; hop < 12; hop++) {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(url, { redirect: "manual", headers: { "User-Agent": USER_AGENT,
      Accept: "text/html", ...(cookie ? { Cookie: cookie } : {}) } });
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0]; const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("legacy redirect omitted Location");
    url = new URL(location, url);
    if (!/^(?:recruiting|myjobs)\.adp\.com$/.test(url.hostname)) throw new Error("legacy redirect left exact ADP hosts");
  }
  throw new Error("legacy redirect exceeded bounded hop count");
}

function decodeSavedUrl(value: string): string {
  return value.replace(/&amp;/gi, "&").replace(/&#0*38;/gi, "&").replace(/&#x0*26;/gi, "&").replace(/&#0*34;/gi, '"');
}

async function resolve(row: Row): Promise<Promotion | null> {
  let legacy: URL;
  try { legacy = new URL(decodeSavedUrl(row.discovered_jobs_url)); } catch { return null; }
  if (legacy.hostname !== "recruiting.adp.com" || !/^\/srccar\/public\/(?:RTI\.home|unsupported\.html)$/i.test(legacy.pathname)) return null;
  const c = legacy.searchParams.get("c");
  const d = legacy.searchParams.get("d")?.match(/^[a-z0-9_-]+/i)?.[0];
  if (!c || !/^\d+$/.test(c) || !d) return null;
  // Saved URLs can contain stale SSO/tracking parameters or HTML/JSON suffixes. The tenant identity
  // is the legacy provider's exact c+d pair, so reconstruct only those public parameters.
  const cleanLegacy = new URL("https://recruiting.adp.com/srccar/public/RTI.home");
  cleanLegacy.searchParams.set("c", c); cleanLegacy.searchParams.set("d", d);
  const response = await followLegacyRedirect(cleanLegacy);
  if (!response.ok) throw new Error(`legacy redirect returned ${response.status}`);
  const final = new URL(response.url);
  if (final.hostname !== "myjobs.adp.com") throw new Error(`legacy redirect did not reach exact MyJobs host`);
  const slug = final.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("MyJobs redirect has no valid tenant slug");
  const configUrl = `https://myjobs.adp.com/public/staffing/v1/career-site/${slug}`;
  const configResponse = await fetch(configUrl, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!configResponse.ok) throw new Error(`tenant configuration returned ${configResponse.status}`);
  const site = await configResponse.json() as Site;
  if (site.domain?.toLowerCase() !== slug || !site.id || !site.orgoid || !site.isiClientId
    || site.active !== true || site.isMyJobsEnabled !== true) throw new Error("tenant configuration has incomplete identity");
  const token = normalizeAdpRmToken(`${slug}|${site.id}|${site.orgoid}|${site.isiClientId}`);
  return { row, token, url: canonicalAdpRmUrl(token) };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = getDb().prepare(
    `SELECT ods.organization_id, ods.resolved_company_id, ods.discovered_jobs_url, o.canonical_name
     FROM organization_discovery_state ods JOIN organizations o ON o.id=ods.organization_id
     WHERE ods.source_resolution_status='NEEDS_ADAPTER' AND ods.resolved_company_id IS NOT NULL
       AND ods.discovered_jobs_url LIKE '%recruiting.adp.com/srccar/%'
     ORDER BY ods.organization_id`
  ).all() as Row[];
  const promotions: Promotion[] = [];
  for (const row of rows) {
    try { const result = await resolve(row); if (result) promotions.push(result); }
    catch (error) { console.log(`[pending] ${row.resolved_company_id}\t${row.canonical_name}\t${error instanceof Error ? error.message : String(error)}`); }
  }
  console.log(`${apply ? "Applying" : "Previewing"} ${promotions.length} ADP Recruiting Management promotion(s).`);
  for (const item of promotions) console.log(`${item.row.resolved_company_id}\t${item.row.canonical_name}\t${item.token}\t${item.url}`);
  if (!apply) return console.log("No database changes made. Re-run with --apply after backup/review.");
  for (const item of promotions) recordDiscoveryResult(item.row.resolved_company_id, { status: "VERIFIED",
    sourceType: "adp_rm", atsBoardToken: item.token, discoveredJobsUrl: item.url,
    reason: "Promoted from exact saved legacy ADP RM redirect and live MyJobs tenant identity", suspectedAts: null });
  console.log(`Applied ${promotions.length} ADP Recruiting Management promotion(s).`);
}

main().catch((error) => { console.error("ADP RM source promotion failed:", error); process.exit(1); });
