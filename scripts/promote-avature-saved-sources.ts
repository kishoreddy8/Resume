import { getDb } from "../src/db";
import { recordDiscoveryResult } from "../src/db/queries/companies";
import { canonicalAvatureUrl, decodeAvatureToken } from "../src/lib/ats/avature";
import { detectAtsFromUrlString } from "../src/lib/ats/detect";

interface Row { organization_id: number; resolved_company_id: number; discovered_jobs_url: string; canonical_name: string }
interface Promotion { row: Row; token: string; url: string }

function metadata(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.match(new RegExp(`<meta\\b[^>]*name=["']${escaped}["'][^>]*content=["']([^"']*)`, "i"))?.[1] ?? null;
}

async function resolve(row: Row): Promise<Promotion | null> {
  const detected = detectAtsFromUrlString(row.discovered_jobs_url.replace(/&amp;/gi, "&"));
  if (!detected || detected.sourceType !== "avature") return null;
  const identity = decodeAvatureToken(detected.atsBoardToken); const url = canonicalAvatureUrl(detected.atsBoardToken);
  const response = await fetch(url, { redirect: "follow", headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`board returned ${response.status}`);
  const final = new URL(response.url); if (final.hostname.toLowerCase() !== identity.host) throw new Error("board redirected outside pinned Avature tenant");
  const html = await response.text();
  if (!/^\d+$/.test(metadata(html, "avature.portal.id") ?? "") || metadata(html, "avature.portal.urlPath") !== identity.portalPath.split("/").at(-1)) {
    throw new Error("board has no exact Avature portal identity");
  }
  if (identity.mode === "template") {
    if (metadata(html, "avature.portal.page") !== identity.page || !/<list\b[^>]*data-props=["'][^"']+/i.test(html)) throw new Error("board has no template job-list configuration");
  } else if (!/class=["'][^"']*list-controls__legend/i.test(html) || !/class=["'][^"']*article--result/i.test(html)) {
    throw new Error("board has no exact-count legacy job listing");
  }
  return { row, token: detected.atsBoardToken, url };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = getDb().prepare(`SELECT ods.organization_id, ods.resolved_company_id, ods.discovered_jobs_url, o.canonical_name
    FROM organization_discovery_state ods JOIN organizations o ON o.id=ods.organization_id
    WHERE ods.source_resolution_status='NEEDS_ADAPTER' AND ods.resolved_company_id IS NOT NULL
      AND (ods.discovered_jobs_url LIKE '%.avature.net/%' OR ods.discovered_jobs_url LIKE '%.avature.com/%') ORDER BY ods.organization_id`).all() as Row[];
  const promotions: Promotion[] = [];
  for (const row of rows) { try { const item = await resolve(row); if (item) promotions.push(item); else console.log(`[pending] ${row.resolved_company_id}\t${row.canonical_name}\tunsupported Avature portal mode`); }
    catch (error) { console.log(`[pending] ${row.resolved_company_id}\t${row.canonical_name}\t${error instanceof Error ? error.message : String(error)}`); } }
  console.log(`${apply ? "Applying" : "Previewing"} ${promotions.length} Avature promotion(s).`);
  for (const item of promotions) console.log(`${item.row.resolved_company_id}\t${item.row.canonical_name}\t${item.token}\t${item.url}`);
  if (!apply) return console.log("No database changes made. Re-run with --apply after backup/review.");
  for (const item of promotions) recordDiscoveryResult(item.row.resolved_company_id, { status: "VERIFIED", sourceType: "avature",
    atsBoardToken: item.token, discoveredJobsUrl: item.url, reason: "Promoted from exact Avature portal mode and listing bootstrap", suspectedAts: null });
  console.log(`Applied ${promotions.length} Avature promotion(s).`);
}
main().catch((error) => { console.error("Avature promotion failed:", error); process.exit(1); });
