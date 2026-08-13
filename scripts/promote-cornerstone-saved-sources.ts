import { getDb } from "../src/db";
import { recordDiscoveryResult } from "../src/db/queries/companies";
import { canonicalCornerstoneUrl, decodeCornerstoneToken } from "../src/lib/ats/cornerstone";
import { detectAtsFromUrlString } from "../src/lib/ats/detect";

interface Row { organization_id: number; resolved_company_id: number; discovered_jobs_url: string; canonical_name: string }
interface Promotion { row: Row; token: string; url: string }

async function resolve(row: Row): Promise<Promotion | null> {
  const detected = detectAtsFromUrlString(row.discovered_jobs_url);
  if (!detected || detected.sourceType !== "cornerstone") return null;
  const identity = decodeCornerstoneToken(detected.atsBoardToken);
  const url = canonicalCornerstoneUrl(detected.atsBoardToken);
  const response = await fetch(url, { redirect: "follow", headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`board returned ${response.status}`);
  const final = new URL(response.url);
  if (final.hostname.toLowerCase() !== identity.host) throw new Error("board redirected outside the pinned Cornerstone tenant");
  const html = await response.text();
  const routeText = html.match(/csodPlayerRouteInfo\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i)?.[1];
  const contextText = html.match(/csod\.context\s*=\s*(\{[\s\S]*?\})\s*;<\/script>/i)?.[1];
  if (!routeText || !contextText) throw new Error("board has no public Cornerstone bootstrap");
  const route = JSON.parse(routeText) as { cid?: string };
  const context = JSON.parse(contextText) as { corp?: string; token?: string; endpoints?: { cloud?: string } };
  let api: URL; try { api = new URL(context.endpoints?.cloud ?? ""); } catch { throw new Error("board has no public API origin"); }
  if (route.cid !== String(identity.siteId) || context.corp?.toLowerCase() !== identity.corp || !context.token
    || !/^[a-z0-9-]+\.api\.csod\.com$/i.test(api.hostname)) throw new Error("board bootstrap identity mismatch");
  return { row, token: detected.atsBoardToken, url };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = getDb().prepare(`SELECT ods.organization_id, ods.resolved_company_id, ods.discovered_jobs_url, o.canonical_name
    FROM organization_discovery_state ods JOIN organizations o ON o.id=ods.organization_id
    WHERE ods.source_resolution_status='NEEDS_ADAPTER' AND ods.resolved_company_id IS NOT NULL
      AND ods.discovered_jobs_url LIKE '%.csod.com/%' ORDER BY ods.organization_id`).all() as Row[];
  const promotions: Promotion[] = [];
  for (const row of rows) { try { const item = await resolve(row); if (item) promotions.push(item); }
    catch (error) { console.log(`[pending] ${row.resolved_company_id}\t${row.canonical_name}\t${error instanceof Error ? error.message : String(error)}`); } }
  console.log(`${apply ? "Applying" : "Previewing"} ${promotions.length} Cornerstone promotion(s).`);
  for (const item of promotions) console.log(`${item.row.resolved_company_id}\t${item.row.canonical_name}\t${item.token}\t${item.url}`);
  if (!apply) return console.log("No database changes made. Re-run with --apply after backup/review.");
  for (const item of promotions) recordDiscoveryResult(item.row.resolved_company_id, { status: "VERIFIED", sourceType: "cornerstone",
    atsBoardToken: item.token, discoveredJobsUrl: item.url, reason: "Promoted from exact Cornerstone tenant/site/corp bootstrap", suspectedAts: null });
  console.log(`Applied ${promotions.length} Cornerstone promotion(s).`);
}
main().catch((error) => { console.error("Cornerstone promotion failed:", error); process.exit(1); });
