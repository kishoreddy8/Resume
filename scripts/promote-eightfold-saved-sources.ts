import { getDb } from "../src/db";
import { recordDiscoveryResult } from "../src/db/queries/companies";
import { canonicalEightfoldUrl, normalizeEightfoldToken } from "../src/lib/ats/eightfold";
import { decodeHtmlEntities } from "../src/lib/stripHtml";

interface Row { organization_id: number; resolved_company_id: number; discovered_jobs_url: string; canonical_name: string }
interface Promotion { row: Row; token: string; url: string }

async function resolve(row: Row): Promise<Promotion | null> {
  let saved: URL; try { saved = new URL(row.discovered_jobs_url.replace(/&amp;/gi, "&").replace(/&#0*34;/gi, "")); } catch { return null; }
  if (!/^[a-z0-9.-]+\.eightfold\.ai$/i.test(saved.hostname)) return null;
  const response = await fetch(`https://${saved.hostname}/careers`, { redirect: "follow", headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`board returned ${response.status}`);
  const final = new URL(response.url); if (!/^[a-z0-9.-]+\.eightfold\.ai$/i.test(final.hostname)) throw new Error("board redirected outside Eightfold");
  const html = await response.text(); const encoded = html.match(/<code\b[^>]*id=["']smartApplyData["'][^>]*>([\s\S]*?)<\/code>/i)?.[1];
  if (!encoded) throw new Error("board has no SmartApply tenant bootstrap");
  const data = JSON.parse(decodeHtmlEntities(encoded)) as { domain?: string; count?: number };
  if (!data.domain || !Number.isInteger(data.count) || (data.count ?? -1) < 0) throw new Error("board bootstrap has no exact domain/count");
  const token = normalizeEightfoldToken(`${final.hostname}|${data.domain}`);
  return { row, token, url: canonicalEightfoldUrl(token) };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const rows = getDb().prepare(`SELECT ods.organization_id, ods.resolved_company_id, ods.discovered_jobs_url, o.canonical_name
    FROM organization_discovery_state ods JOIN organizations o ON o.id=ods.organization_id
    WHERE ods.source_resolution_status='NEEDS_ADAPTER' AND ods.resolved_company_id IS NOT NULL
      AND ods.discovered_jobs_url LIKE '%.eightfold.ai/%' ORDER BY ods.organization_id`).all() as Row[];
  const promotions: Promotion[] = [];
  for (const row of rows) { try { const item = await resolve(row); if (item) promotions.push(item); }
    catch (error) { console.log(`[pending] ${row.resolved_company_id}\t${row.canonical_name}\t${error instanceof Error ? error.message : String(error)}`); } }
  console.log(`${apply ? "Applying" : "Previewing"} ${promotions.length} Eightfold promotion(s).`);
  for (const item of promotions) console.log(`${item.row.resolved_company_id}\t${item.row.canonical_name}\t${item.token}\t${item.url}`);
  if (!apply) return console.log("No database changes made. Re-run with --apply after backup/review.");
  for (const item of promotions) recordDiscoveryResult(item.row.resolved_company_id, { status: "VERIFIED", sourceType: "eightfold",
    atsBoardToken: item.token, discoveredJobsUrl: item.url, reason: "Promoted from exact Eightfold SmartApply host/domain bootstrap", suspectedAts: null });
  console.log(`Applied ${promotions.length} Eightfold promotion(s).`);
}
main().catch((error) => { console.error("Eightfold promotion failed:", error); process.exit(1); });
