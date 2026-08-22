import { getDb } from "@/db";

export type AdminCompanySort = "name" | "last_scan" | "failures";

export function listAdminCompanies(input: { page: number; limit: number; search: string; active: string; source: string; health: string; sort: AdminCompanySort }) {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (input.search) { where.push("c.name LIKE @search ESCAPE '\\'"); params.search = `%${input.search.replace(/[\\%_]/g, "\\$&")}%`; }
  if (input.active === "active" || input.active === "paused") { where.push("c.is_active = @isActive"); params.isActive = input.active === "active" ? 1 : 0; }
  if (input.source) { where.push("c.source_type = @source"); params.source = input.source; }
  if (input.health) { where.push("c.connector_health = @health"); params.health = input.health; }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = input.sort === "last_scan" ? "COALESCE(c.last_scanned_at, '') DESC, c.id DESC" : input.sort === "failures" ? "c.consecutive_failures DESC, c.name COLLATE NOCASE" : "c.name COLLATE NOCASE, c.id";
  const offset = (input.page - 1) * input.limit;
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM companies c ${whereSql}`).get(params) as { count: number }).count;
  const companies = getDb().prepare(
    `SELECT c.id, c.name, c.source_type AS sourceType, c.is_active AS isActive,
            c.connector_health AS connectorHealth, c.resolution_status AS resolutionStatus,
            c.last_scanned_at AS lastScannedAt, c.last_scan_status AS lastScanStatus,
            c.consecutive_failures AS consecutiveFailures, c.last_error_message AS lastErrorMessage,
            c.career_page_url AS careerPageUrl, c.discovery_reason AS discoveryReason,
            COALESCE(j.activeJobs, 0) AS activeJobs
     FROM companies c
     LEFT JOIN (SELECT company_id, COUNT(*) AS activeJobs FROM jobs WHERE is_active = 1 GROUP BY company_id) j ON j.company_id = c.id
     ${whereSql} ORDER BY ${order} LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit: input.limit, offset });
  return { companies, page: input.page, limit: input.limit, total, totalPages: Math.max(1, Math.ceil(total / input.limit)) };
}
