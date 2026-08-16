import pLimit from "p-limit";
import { extractSalaryText } from "@/lib/extractSalary";
import { classifyJobLocation } from "@/lib/jobLocationScope";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

export interface SuccessFactorsIdentity {
  host: string;
  company: string;
}

export interface FetchSuccessFactorsJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  originOverride?: string;
  detailConcurrency?: number;
  allowPrivateNetworksForTests?: boolean;
  trustedCustomHost?: string;
  allowStableStaleCount?: boolean;
}

export interface SuccessFactorsListingPosting {
  id: number | string;
  title: string;
  postingDate?: string;
  defaultLocale?: string;
  jobReqSecKey?: string;
  otherValues?: Array<Array<{ fieldId?: string; shortVal?: string | null; longVal?: string | null; internalVal?: string | null }>>;
  [key: string]: unknown;
}

export interface SuccessFactorsDwrPayload {
  filters?: {
    postingCount?: string | number;
    searchURL?: string;
    [key: string]: unknown;
  };
  results?: {
    postingCount?: string | number;
    totalPostings?: string | number;
    detailURLPrefix?: string;
    postings?: SuccessFactorsListingPosting[];
    options?: {
      pagination?: {
        currentPage?: number;
        pageSize?: number;
        startRow?: number;
        endRow?: number;
        totalCount?: number;
      };
      sortByColumn?: string;
      sortOrder?: string;
    };
    [key: string]: unknown;
  };
  postings?: SuccessFactorsListingPosting[];
  options?: {
    pagination?: {
      currentPage?: number;
      pageSize?: number;
      startRow?: number;
      endRow?: number;
      totalCount?: number;
    };
    sortByColumn?: string;
    sortOrder?: string;
  };
  [key: string]: unknown;
}

export type SuccessFactorsEndRowMode = "PAGE_BOUNDARY" | "ACTUAL_ROW_CAP";

const HOST_PATTERN = /^[a-z0-9.-]+\.successfactors\.(?:com|eu)$/i;
const COMPANY_PATTERN = /^[a-z0-9_.-]+$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function decodeSuccessFactorsToken(value: string): SuccessFactorsIdentity {
  const parts = value.trim().split("|");
  const host = (parts[0] || "").trim().toLowerCase();
  const company = (parts[1] || "").trim();
  if (parts.length !== 2 || !host || !company || !HOST_PATTERN.test(host) || !COMPANY_PATTERN.test(company)) {
    throw new Error("Invalid SuccessFactors host|company token");
  }
  return { host, company };
}

export function encodeSuccessFactorsToken(identity: SuccessFactorsIdentity): string {
  const host = identity.host.toLowerCase().trim();
  const company = identity.company.trim();
  if (!HOST_PATTERN.test(host) || !COMPANY_PATTERN.test(company)) {
    throw new Error("Invalid SuccessFactors host|company identity");
  }
  return `${host}|${company}`;
}

export function normalizeSuccessFactorsToken(value: string): string {
  return encodeSuccessFactorsToken(decodeSuccessFactorsToken(value));
}

export function canonicalSuccessFactorsUrl(value: string): string {
  const { host, company } = decodeSuccessFactorsToken(normalizeSuccessFactorsToken(value));
  return `https://${host}/career?company=${encodeURIComponent(company)}`;
}

interface SuccessFactorsBootstrap {
  cookieHeader: string;
  jsessionId: string;
  crb: string;
  viewId: string;
  viewState: string;
}

/**
 * Validates a bootstrap response redirect target against source authority.
 * Rejects any external redirect ending outside identity.host (or test originOverride).
 * Prevents circular trust by requiring bootstrap responses to terminate on identity.host.
 */
export function validateBootstrapRedirectHost(
  finalUrlStr: string,
  identity: SuccessFactorsIdentity,
  originOverride?: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(finalUrlStr);
  } catch {
    throw new Error(`SuccessFactors bootstrap response returned a malformed URL: ${finalUrlStr}`);
  }

  const isTestOverride = Boolean(originOverride);
  if (isTestOverride) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`SuccessFactors bootstrap response returned an invalid protocol: ${parsed.protocol}`);
    }
  } else {
    if (parsed.protocol !== "https:") {
      throw new Error(`SuccessFactors bootstrap response requires HTTPS protocol (got ${parsed.protocol})`);
    }
  }

  if (parsed.username || parsed.password) {
    throw new Error("SuccessFactors bootstrap URL must not contain user credentials");
  }

  const savedHost = identity.host.toLowerCase();
  const resHost = parsed.hostname.toLowerCase();
  let overrideHost: string | undefined = undefined;
  if (originOverride) {
    try {
      overrideHost = new URL(originOverride).hostname.toLowerCase();
    } catch {}
  }

  // Response MUST remain on saved host (or originOverride test host)
  if (resHost !== savedHost && (!overrideHost || resHost !== overrideHost)) {
    throw new Error(`SuccessFactors bootstrap redirected to an untrusted external host: ${resHost}`);
  }
}

async function fetchBootstrap(
  origin: string,
  identity: SuccessFactorsIdentity,
  options: FetchWithRetryOptions,
  originOverride?: string
): Promise<SuccessFactorsBootstrap> {
  const pageUrl = `${origin}/career?company=${encodeURIComponent(identity.company)}`;
  const pageRes = await fetchWithRetry(pageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  }, options);

  if (pageRes.url) {
    validateBootstrapRedirectHost(pageRes.url, identity, originOverride);
  }

  const cookieHeader = pageRes.headers.get("set-cookie") || "";
  const html = await pageRes.text();

  const jsessionIdMatch = cookieHeader.match(/JSESSIONID=([^;]+)/i);
  const jsessionId = jsessionIdMatch ? jsessionIdMatch[1] : "";

  const crbMatch = html.match(/ajaxSecKey="([^"]+)"/i) || html.match(/_s\.crb=([^"'&]+)/i);
  const crb = crbMatch ? decodeURIComponent(crbMatch[1]) : "";

  const viewStateMatch =
    html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/i) ||
    html.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]+)"/i);
  const viewState = viewStateMatch ? viewStateMatch[1] : "";

  return {
    cookieHeader,
    jsessionId,
    crb,
    viewId: "/ui/rcmcareer/pages/careersite/career.jsp.xhtml",
    viewState,
  };
}

function parseStringLiteral(str: string): string {
  const quote = str[0];
  if ((quote !== '"' && quote !== "'") || str[str.length - 1] !== quote || str.length < 2) {
    throw new Error(`Invalid string literal in DWR response: ${str}`);
  }
  const content = str.slice(1, -1);
  return content.replace(/\\(["'\\/bfnrt])/g, (_, c) => {
    switch (c) {
      case '"': return '"';
      case "'": return "'";
      case "\\": return "\\";
      case "/": return "/";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return c;
    }
  }).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseLiteralValue(raw: string, symbols: Map<string, unknown>): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "undefined") return undefined;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return parseStringLiteral(trimmed);
  }

  if (symbols.has(trimmed)) {
    return symbols.get(trimmed);
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const obj: Record<string, unknown> = {};
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return obj;
    const pairs = inner.split(",");
    for (const pair of pairs) {
      const idx = pair.indexOf(":");
      if (idx === -1) throw new Error(`Invalid object entry in DWR: ${pair}`);
      const k = pair.slice(0, idx).trim().replace(/^["']|["']$/g, "");
      if (FORBIDDEN_KEYS.has(k)) throw new Error(`Forbidden key in DWR object: ${k}`);
      const v = parseLiteralValue(pair.slice(idx + 1), symbols);
      obj[k] = v;
    }
    return obj;
  }

  throw new Error(`Unrecognized or untrusted DWR literal value: ${trimmed.slice(0, 50)}`);
}

/**
 * Deterministic, non-executing DWR parser.
 * Replaces new Function / eval with strict token/grammar parsing to eliminate RCE risk.
 */
export function parseDwrResponse(
  dwrText: string,
  expectedBatchId?: string,
  expectedCallId: string = "0"
): SuccessFactorsDwrPayload {
  if (dwrText.length > 10 * 1024 * 1024) {
    throw new Error("DWR response exceeds maximum allowed size cap of 10MB");
  }

  const symbols = new Map<string, unknown>();
  let callbackResult: unknown = null;
  let exceptionResult: unknown = null;
  let callbackCount = 0;

  const lines = dwrText.split(/\r?\n/);
  let statementCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    // Permit ONLY the exact known SuccessFactors DWR boilerplate throw statement
    if (trimmed.startsWith("throw ")) {
      if (!/^throw\s+['"]allowScriptTagRemoting is false\.['"];?$/i.test(trimmed)) {
        throw new Error(`Unexpected throw statement in DWR response: ${trimmed.slice(0, 60)}`);
      }
      continue;
    }

    // Split statements on ';' outside string quotes
    const statements: string[] = [];
    let current = "";
    let inString = false;
    let stringQuote = "";
    let escape = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (escape) {
        current += char;
        escape = false;
        continue;
      }
      if (char === "\\") {
        current += char;
        escape = true;
        continue;
      }
      if (inString) {
        current += char;
        if (char === stringQuote) inString = false;
        continue;
      }
      if (char === '"' || char === "'") {
        inString = true;
        stringQuote = char;
        current += char;
        continue;
      }
      if (char === ";") {
        statements.push(current.trim());
        current = "";
        continue;
      }
      current += char;
    }
    if (current.trim()) statements.push(current.trim());

    for (const stmt of statements) {
      if (!stmt || stmt.startsWith("//")) continue;
      if (stmt.startsWith("throw ")) {
        if (!/^throw\s+['"]allowScriptTagRemoting is false\.['"];?$/i.test(stmt)) {
          throw new Error(`Unexpected throw statement in DWR response: ${stmt.slice(0, 60)}`);
        }
        continue;
      }

      statementCount++;
      if (statementCount > 50_000) {
        throw new Error("DWR response exceeded maximum statement cap of 50,000");
      }

      // Rejection of prohibited JS execution keywords OUTSIDE string literals
      const stmtWithoutStrings = stmt.replace(/(["'])(?:\\.|[^\\])*?\1/g, "");
      if (/\b(?:eval|Function|import|require|process|global|window|document|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|Math|Reflect|Proxy|new|function)\b/.test(stmtWithoutStrings)) {
        throw new Error(`DWR statement contains prohibited executable JS keyword: ${stmt.slice(0, 60)}`);
      }

      // Pattern 1: var s0={}; or var s0=[];
      const varDeclMatch = stmt.match(/^var\s+([a-zA-Z0-9_$]+)\s*=\s*(\{\}|\[\]);?$/);
      if (varDeclMatch) {
        const [, varName, initType] = varDeclMatch;
        if (FORBIDDEN_KEYS.has(varName)) throw new Error(`Forbidden variable name in DWR: ${varName}`);
        symbols.set(varName, initType === "{}" ? {} : []);
        continue;
      }

      // Pattern 2: Assignment s0.prop = val; or s0["prop"] = val; or s0[0] = val;
      const assignMatch = stmt.match(/^([a-zA-Z0-9_$]+)(?:\.([a-zA-Z0-9_$]+)|\[(["']?)([^"']+)\3\])\s*=\s*([\s\S]+)$/);
      if (assignMatch) {
        const [, varName, dotProp, , bracketProp, rhs] = assignMatch;
        const prop = dotProp || bracketProp;
        if (FORBIDDEN_KEYS.has(prop)) throw new Error(`Forbidden property in DWR assignment: ${prop}`);

        const container = symbols.get(varName);
        if (!container || typeof container !== "object") {
          throw new Error(`DWR assignment target ${varName} is undefined or not an object`);
        }

        const value = parseLiteralValue(rhs, symbols);
        if (Array.isArray(container) && /^\d+$/.test(prop)) {
          container[Number(prop)] = value;
        } else {
          (container as Record<string, unknown>)[prop] = value;
        }
        continue;
      }

      // Pattern 3: Callback dwr.engine._remoteHandleCallback('0','0',s0);
      const callbackMatch = stmt.match(/^dwr\.engine\._remoteHandleCallback\s*\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*,\s*([\s\S]+)\s*\);?$/);
      if (callbackMatch) {
        callbackCount++;
        if (callbackCount > 1) {
          throw new Error("DWR response contained multiple callback invocations");
        }
        const [, batchId, callId, rawVal] = callbackMatch;
        if (expectedBatchId !== undefined && batchId !== expectedBatchId) {
          throw new Error(`DWR callback batch ID mismatch (expected ${expectedBatchId}, got ${batchId})`);
        }
        if (expectedCallId !== undefined && callId !== expectedCallId) {
          throw new Error(`DWR callback call ID mismatch (expected ${expectedCallId}, got ${callId})`);
        }
        callbackResult = parseLiteralValue(rawVal, symbols);
        continue;
      }

      // Pattern 4: Exception dwr.engine._remoteHandleException('0','0',...);
      const exceptionMatch = stmt.match(/^dwr\.engine\._remoteHandleException\s*\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*,\s*([\s\S]+)\s*\);?$/);
      if (exceptionMatch) {
        callbackCount++;
        if (callbackCount > 1) {
          throw new Error("DWR response contained multiple callback invocations");
        }
        const [, batchId, callId, rawVal] = exceptionMatch;
        if (expectedBatchId !== undefined && batchId !== expectedBatchId) {
          throw new Error(`DWR exception batch ID mismatch (expected ${expectedBatchId}, got ${batchId})`);
        }
        if (expectedCallId !== undefined && callId !== expectedCallId) {
          throw new Error(`DWR exception call ID mismatch (expected ${expectedCallId}, got ${callId})`);
        }
        exceptionResult = parseLiteralValue(rawVal, symbols);
        continue;
      }

      throw new Error(`Unsupported or malformed statement in DWR response: ${stmt.slice(0, 80)}`);
    }
  }

  if (exceptionResult) {
    const errObj = exceptionResult as { message?: string; errorType?: string };
    throw new Error(`SuccessFactors DWR server exception: ${errObj.message || errObj.errorType || "Unknown error"}`);
  }

  if (callbackCount !== 1 || !callbackResult || typeof callbackResult !== "object") {
    throw new Error("SuccessFactors DWR response did not return exactly one valid callback payload");
  }

  const record = callbackResult as Record<string, unknown>;
  if (record.payload && typeof record.payload === "object") {
    return record.payload as SuccessFactorsDwrPayload;
  }

  return record as SuccessFactorsDwrPayload;
}

const EXPLICIT_LOCATION_FIELD_IDS = new Set([
  "location",
  "location_obj",
  "city",
  "state",
  "country",
  "zipcode",
  "postalcode",
]);

const EXCLUDE_FIELD_IDS = /department|division|category|business unit|travel|employment/i;

export function extractLocationFromPosting(posting: SuccessFactorsListingPosting): string {
  const locationValues: string[] = [];

  if (Array.isArray(posting.otherValues)) {
    for (const group of posting.otherValues) {
      if (Array.isArray(group)) {
        for (const item of group) {
          const fieldId = (item?.fieldId || "").toLowerCase();
          const val = (item?.shortVal ?? item?.longVal ?? item?.internalVal)?.trim();

          if (!val) continue;

          // Exclude explicit non-location fields
          if (EXCLUDE_FIELD_IDS.test(fieldId)) continue;

          // Accept if explicitly labelled location field ID
          if (EXPLICIT_LOCATION_FIELD_IDS.has(fieldId)) {
            if (val.startsWith("[")) {
              try {
                const parsed = JSON.parse(val);
                if (Array.isArray(parsed)) {
                  const locTokens = parsed
                    .filter((t) => typeof t === "string" && !EXCLUDE_FIELD_IDS.test(t) && t !== "Location" && !t.startsWith("Job Location"))
                    .map((t) => String(t).trim());
                  for (const tok of locTokens) {
                    if (tok && !locationValues.includes(tok)) locationValues.push(tok);
                  }
                }
              } catch {
                if (!EXCLUDE_FIELD_IDS.test(val) && !locationValues.includes(val)) {
                  locationValues.push(val);
                }
              }
            } else if (!EXCLUDE_FIELD_IDS.test(val) && !locationValues.includes(val)) {
              locationValues.push(val);
            }
          } else if (val.startsWith('["Location"') || val.startsWith('["Job Location"')) {
            // Accept generic fields ONLY when value explicitly has a Location or Job Location JSON array label
            try {
              const parsed = JSON.parse(val);
              if (Array.isArray(parsed)) {
                const locTokens = parsed
                  .filter((t) => typeof t === "string" && !EXCLUDE_FIELD_IDS.test(t) && t !== "Location" && !t.startsWith("Job Location"))
                  .map((t) => String(t).trim());
                for (const tok of locTokens) {
                  if (tok && !locationValues.includes(tok)) locationValues.push(tok);
                }
              }
            } catch {}
          }
        }
      }
    }
  }

  return locationValues.length > 0 ? locationValues.join(", ") : "Unknown";
}

function parsePostingDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractJobDescriptionFromHtml(html: string): string {
  // Reject SSO / login redirects, application error pages, and talent community pages
  if (/<form[^>]*name=["']loginForm["']/i.test(html) || /id=["']login["']/i.test(html) || /\bsaml\/login\b/i.test(html)) {
    throw new Error("SuccessFactors detail page returned an SSO/login redirect");
  }
  if (/The job requisition is no longer available/i.test(html) || /<title>[^<]*404 Not Found/i.test(html) || /Application Error/i.test(html)) {
    throw new Error("SuccessFactors detail page returned a 404/error page");
  }
  if (/join our talent community/i.test(html) && !/jobdescription|joqReqDescription|jobReqDescription/i.test(html)) {
    throw new Error("SuccessFactors detail page returned a talent community page");
  }

  // Extract ONLY supported description containers
  const match = html.match(/<[^>]*class=["'][^"']*(?:jobdescription|joqReqDescription|jobReqDescription|externalPosting)[^"']*["'][^>]*>/i);
  if (match && match.index !== undefined) {
    const start = match.index + match[0].length;
    const rest = html.slice(start);
    const endMatch = rest.match(/<div[^>]*class=["'][^"']*(?:button_row|jobDisplayShell|sfpanel_wrapper|footer)[^"']*["']/i) || rest.match(/<\/body>/i);
    const end = endMatch && endMatch.index !== undefined ? endMatch.index : rest.length;
    const chunk = rest.slice(0, end);
    if (stripHtml(chunk).trim().length >= 50) return chunk;
  }

  // Check structured JSON-LD JobPosting schema
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const jsonLdMatch of jsonLdMatches) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      if (data && (data["@type"] === "JobPosting" || data.type === "JobPosting")) {
        const desc = data.description || data.jobDescription;
        if (typeof desc === "string" && stripHtml(desc).trim().length >= 50) {
          return desc;
        }
      }
    } catch {}
  }

  throw new Error("SuccessFactors job detail page has no supported description container or description is incomplete");
}

/**
 * Pure hostname-validation helper for SuccessFactors detail responses.
 * Validates that the response URL is well-formed, uses http/https, and matches one of the pre-authorized trusted hosts.
 */
export function isDetailHostTrusted(
  finalUrlStr: string,
  trustedHosts: ReadonlySet<string>
): boolean {
  try {
    const parsed = new URL(finalUrlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return trustedHosts.has(host);
  } catch {
    return false;
  }
}

export function validateDetailResponseUrl(
  finalUrlStr: string,
  trustedHosts: ReadonlySet<string>
): URL {
  let parsed: URL;
  try {
    parsed = new URL(finalUrlStr);
  } catch {
    throw new Error(`SuccessFactors detail response returned a malformed URL: ${finalUrlStr}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`SuccessFactors detail response returned an invalid protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("SuccessFactors detail response URL must not contain user credentials");
  }

  const host = parsed.hostname.toLowerCase();
  if (!trustedHosts.has(host)) {
    throw new Error(`SuccessFactors detail response redirected to an untrusted host (expected ${Array.from(trustedHosts).join(" or ")}, got ${host})`);
  }

  return parsed;
}

function parseJobDetail(
  html: string,
  posting: SuccessFactorsListingPosting,
  identity: SuccessFactorsIdentity,
  origin: string,
  trustedHosts: ReadonlySet<string>,
  finalResponseUrl?: string
): NormalizedJob {
  const externalId = String(posting.id);
  const listingTitle = posting.title?.trim();
  if (!externalId || !listingTitle) {
    throw new Error(`SuccessFactors job missing required listing identity for ID ${externalId}`);
  }

  // 1. Validate response URL hostname and parse URL once
  let parsedUrl: URL | null = null;
  if (finalResponseUrl) {
    parsedUrl = validateDetailResponseUrl(finalResponseUrl, trustedHosts);
  }

  // 2. Parse all JSON-LD blocks safely and collect structured entities
  let jsonLdJobPosting: Record<string, unknown> | null = null;
  const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const jsonLdMatch of jsonLdMatches) {
    try {
      const parsed = JSON.parse(jsonLdMatch[1]);
      if (parsed && typeof parsed === "object") {
        if (parsed["@type"] === "JobPosting" || parsed.type === "JobPosting") {
          jsonLdJobPosting = parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Ignore non-JSON-LD scripts or malformed JSON blocks
    }
  }

  // 3. Exact structured requisition ID verification
  const urlReqId = parsedUrl?.searchParams.get("career_job_req_id") ?? parsedUrl?.searchParams.get("jobReqId");
  const hasUrlReqMatch = urlReqId === externalId;

  const hasAttributeReqMatch =
    new RegExp(`name=["']jobReqId["']\\s*value=["']${externalId}["']`, "i").test(html) ||
    new RegExp(`id=["']jobReqId["']\\s*value=["']${externalId}["']`, "i").test(html) ||
    new RegExp(`data-jobid=["']${externalId}["']`, "i").test(html) ||
    new RegExp(`data-career-job-req-id=["']${externalId}["']`, "i").test(html) ||
    new RegExp(`data-job-req-id=["']${externalId}["']`, "i").test(html) ||
    new RegExp(`["']internalId["']\\s*:\\s*["']${externalId}-[a-zA-Z]{2}_[a-zA-Z]{2}["']`, "i").test(html) ||
    new RegExp(`["']jobReqId["']\\s*:\\s*["']${externalId}["']`, "i").test(html) ||
    new RegExp(`(?:Job\\s*ID|Requisition\\s*(?:ID|#?)|Req\\s*#?):?\\s*(?:<[^>]+>)*\\s*${externalId}\\b`, "i").test(html);

  let hasJsonLdReqMatch = false;
  if (jsonLdJobPosting) {
    const rawId = jsonLdJobPosting.identifier;
    let idVal = "";
    if (typeof rawId === "string" || typeof rawId === "number") {
      idVal = String(rawId);
    } else if (rawId && typeof rawId === "object") {
      idVal = String((rawId as { value?: string | number }).value ?? "");
    }
    if (idVal) {
      if (idVal !== externalId) {
        throw new Error(`SuccessFactors JSON-LD identifier mismatch (expected ${externalId}, got ${idVal})`);
      }
      hasJsonLdReqMatch = true;
    }

    const ldUrl = jsonLdJobPosting.url || jsonLdJobPosting.mainEntityOfPage;
    if (typeof ldUrl === "string" && ldUrl.trim().length > 0) {
      try {
        const parsedLdUrl = new URL(ldUrl, origin);
        if (!parsedLdUrl.href.includes(externalId)) {
          throw new Error(`SuccessFactors JSON-LD URL mismatch (expected URL containing ${externalId}, got ${ldUrl})`);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("JSON-LD URL mismatch")) throw err;
      }
    }
  }

  const hasReqEvidence = hasUrlReqMatch || hasAttributeReqMatch || hasJsonLdReqMatch;
  if (!hasReqEvidence) {
    throw new Error(`SuccessFactors detail page missing positive requisition ID evidence for ID ${externalId}`);
  }

  // 4. Exact structured tenant identity verification
  const targetCompany = identity.company.toLowerCase();
  const urlCompany = parsedUrl?.searchParams.get("company")?.toLowerCase() ??
                     parsedUrl?.searchParams.get("companyname")?.toLowerCase() ??
                     parsedUrl?.searchParams.get("company_name")?.toLowerCase();
  const hasUrlCompanyMatch = urlCompany === targetCompany;

  const hasAttributeCompanyMatch =
    new RegExp(`name=["']company["']\\s*value=["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`id=["']company["']\\s*value=["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`data-company=["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`data-tenant=["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`["']ssoCompanyId["']\\s*:\\s*["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`["']company["']\\s*:\\s*["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`["']companyId["']\\s*:\\s*["']${targetCompany}["']`, "i").test(html) ||
    new RegExp(`["']sourceId["']\\s*:\\s*["'][^"']*${targetCompany}["']`, "i").test(html);

  let hasJsonLdCompanyMatch = false;
  if (jsonLdJobPosting) {
    const hiringOrg = jsonLdJobPosting.hiringOrganization;
    if (hiringOrg && typeof hiringOrg === "object") {
      const orgRecord = hiringOrg as Record<string, unknown>;
      const orgName = String(orgRecord.name ?? "").toLowerCase();
      const orgLegal = String(orgRecord.legalName ?? "").toLowerCase();
      const orgId = String(orgRecord.identifier ?? "").toLowerCase();
      if (orgName === targetCompany || orgLegal === targetCompany || orgId === targetCompany) {
        hasJsonLdCompanyMatch = true;
      }
    }
  }

  const hasCompanyEvidence = hasUrlCompanyMatch || hasAttributeCompanyMatch || hasJsonLdCompanyMatch;
  if (!hasCompanyEvidence) {
    throw new Error(`SuccessFactors detail page missing positive company identity evidence for company ${identity.company}`);
  }

  // 5. Title Identity Validation
  const h1TitleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1TitleMatch) {
    const detailTitle = stripHtml(h1TitleMatch[1]).trim();
    if (detailTitle && detailTitle.length >= 3) {
      const normListing = listingTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normDetail = detailTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!normListing.includes(normDetail) && !normDetail.includes(normListing)) {
        throw new Error(`SuccessFactors detail page title mismatch (listing: "${listingTitle}", detail: "${detailTitle}")`);
      }
    }
  }

  const descriptionHtml = extractJobDescriptionFromHtml(html);
  const descriptionText = stripHtml(descriptionHtml);
  if (!descriptionText || descriptionText.length < 50) {
    throw new Error(`SuccessFactors job ${externalId} description text is under minimum length requirement (50 chars)`);
  }

  let location = extractLocationFromPosting(posting);
  if (location === "Unknown") {
    const locMatch =
      html.match(/Location:\s*<\/span>[\s\S]*?<span[^>]*class=["']joblayouttoken-value["'][^>]*>([\s\S]*?)<\/span>/i) ||
      html.match(/Location:\s*[\r\n\s]*([^\r\n<]+)/i);
    if (locMatch) {
      const loc = locMatch[1].replace(/<[^>]+>/g, " ").replace(/#job-location[\s\S]*/, "").replace(/[.,;]+$/, "").trim();
      if (loc && !EXCLUDE_FIELD_IDS.test(loc)) location = loc;
    }
  }

  let department: string | null = null;
  const deptMatch = html.match(/Department:\s*<\/span>[\s\S]*?<span[^>]*class=["']joblayouttoken-value["'][^>]*>([\s\S]*?)<\/span>/i);
  if (deptMatch) {
    department = stripHtml(deptMatch[1]).trim() || null;
  }

  let workplaceType: string | null = null;
  const wpMatch = html.match(/Workplace Type:\s*[\r\n\s]*([^\r\n<]+)/i);
  if (wpMatch) {
    const wp = wpMatch[1].trim();
    if (/remote/i.test(wp)) workplaceType = "Remote";
    else if (/hybrid/i.test(wp)) workplaceType = "Hybrid";
    else if (/on-site|onsite/i.test(wp)) workplaceType = "On-site";
  }
  if (!workplaceType && /\bremote\b/i.test(location)) {
    workplaceType = "Remote";
  }

  const salaryText = extractSalaryText(descriptionText);
  const canonicalUrl = `${origin}/career?career_ns=job_listing&company=${encodeURIComponent(identity.company)}&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&career_job_req_id=${externalId}`;

  return {
    externalId,
    title: listingTitle,
    location,
    department,
    url: canonicalUrl,
    descriptionHtml,
    descriptionText,
    employmentType: null,
    workplaceType,
    salaryText,
    postedAt: parsePostingDate(posting.postingDate),
    raw: { identity, posting },
  };
}

interface SnapshotResult {
  postings: SuccessFactorsListingPosting[];
  authoritativePublicJobCount: number;
  pageSize: number;
  finalPageIsShort: boolean;
  initialPayload: SuccessFactorsDwrPayload;
}

async function fetchListingSnapshot(
  origin: string,
  identity: SuccessFactorsIdentity,
  bootstrap: SuccessFactorsBootstrap,
  headers: Record<string, string>,
  searchUrl: string,
  options: FetchSuccessFactorsJobsOptions
): Promise<SnapshotResult> {
  // 1. Fetch Page 1 via search.dwr
  const initialSearchBody = [
    "callCount=1",
    `page=${encodeURIComponent(`/career?company=${identity.company}`)}`,
    `httpSessionId=${bootstrap.jsessionId}`,
    "scriptSessionId=80A8BD291A8E635A37D57F13E5D1F423100",
    "c0-scriptName=careerJobSearchControllerProxy",
    "c0-methodName=search",
    "c0-id=0",
    "c0-param0=Object_Object:{pagination:reference:c0-e1, sortByColumn:reference:c0-e2, sortOrder:reference:c0-e3}",
    "c0-e1=Object_Object:{currentPage:number:1, endRow:number:10, increaseCandSummaryPagination:boolean:false, pageSize:number:10, startRow:number:1, totalCount:number:0}",
    "c0-e2=string:JOB_POSTING_DATE",
    "c0-e3=string:DESC",
    "batchId=0",
  ].join("\n") + "\n";

  const initialRes = await fetchWithRetry(searchUrl, {
    method: "POST",
    headers,
    body: initialSearchBody,
  }, options);

  const initialDwrText = await initialRes.text();
  const initialPayload = parseDwrResponse(initialDwrText, "0", "0");

  const initialRecord = initialPayload as Record<string, unknown>;
  const initialOptions = (initialPayload.results?.options ?? initialRecord.options) as {
    pagination?: { currentPage?: number; pageSize?: number; startRow?: number; endRow?: number; totalCount?: number };
    sortByColumn?: string;
    sortOrder?: string;
  } | undefined;

  const paginationMeta1 = initialOptions?.pagination;
  if (
    !paginationMeta1 ||
    typeof paginationMeta1.currentPage !== "number" ||
    typeof paginationMeta1.pageSize !== "number" ||
    typeof paginationMeta1.startRow !== "number" ||
    typeof paginationMeta1.endRow !== "number" ||
    typeof paginationMeta1.totalCount !== "number"
  ) {
    throw new Error("SuccessFactors listing returned missing or invalid pagination metadata on page 1");
  }

  const pageSize = paginationMeta1.pageSize;
  if (pageSize <= 0) {
    throw new Error(`SuccessFactors listing returned invalid pageSize: ${pageSize}`);
  }

  const authoritativePublicJobCount = paginationMeta1.totalCount;
  if (!Number.isInteger(authoritativePublicJobCount) || authoritativePublicJobCount < 0) {
    throw new Error(`SuccessFactors listing returned invalid totalCount on page 1: ${authoritativePublicJobCount}`);
  }

  const firstBatch = initialPayload.results?.postings ?? initialPayload.postings ?? [];

  // Handle empty board contract explicitly
  if (authoritativePublicJobCount === 0) {
    if (paginationMeta1.currentPage !== 1) {
      throw new Error(`SuccessFactors empty board returned wrong currentPage: ${paginationMeta1.currentPage}`);
    }
    if (paginationMeta1.startRow !== 1 && paginationMeta1.startRow !== 0) {
      throw new Error(`SuccessFactors empty board returned invalid startRow: ${paginationMeta1.startRow}`);
    }
    if (paginationMeta1.endRow !== 0) {
      throw new Error(`SuccessFactors empty board returned invalid endRow: ${paginationMeta1.endRow}`);
    }
    if (initialOptions?.sortByColumn !== "JOB_POSTING_DATE") {
      throw new Error(`SuccessFactors empty board returned incorrect sortByColumn: ${initialOptions?.sortByColumn}`);
    }
    if (initialOptions?.sortOrder !== "DESC") {
      throw new Error(`SuccessFactors empty board returned incorrect sortOrder: ${initialOptions?.sortOrder}`);
    }
    if (!Array.isArray(firstBatch) || firstBatch.length !== 0) {
      throw new Error(`SuccessFactors empty board returned non-empty postings array: ${firstBatch.length}`);
    }
    return {
      postings: [],
      authoritativePublicJobCount: 0,
      pageSize,
      finalPageIsShort: false,
      initialPayload,
    };
  }

  if (paginationMeta1.currentPage !== 1) {
    throw new Error(`SuccessFactors page 1 returned wrong currentPage: ${paginationMeta1.currentPage}`);
  }
  if (paginationMeta1.startRow !== 1) {
    throw new Error(`SuccessFactors page 1 returned wrong startRow (expected 1, got ${paginationMeta1.startRow})`);
  }

  // Determine and establish endRowMode on Page 1 if totalCount < pageSize
  let endRowMode: SuccessFactorsEndRowMode | undefined = undefined;
  if (authoritativePublicJobCount < pageSize) {
    if (paginationMeta1.endRow === authoritativePublicJobCount) {
      endRowMode = "ACTUAL_ROW_CAP";
    } else if (paginationMeta1.endRow === pageSize) {
      endRowMode = "PAGE_BOUNDARY";
    } else {
      throw new Error(`SuccessFactors page 1 returned invalid endRow: ${paginationMeta1.endRow} (expected ${authoritativePublicJobCount} or ${pageSize})`);
    }
  } else {
    if (paginationMeta1.endRow !== pageSize) {
      throw new Error(`SuccessFactors page 1 returned invalid endRow: ${paginationMeta1.endRow} (expected ${pageSize})`);
    }
  }

  if (initialOptions?.sortByColumn !== "JOB_POSTING_DATE") {
    throw new Error(`SuccessFactors page 1 returned incorrect sortByColumn (expected JOB_POSTING_DATE, got ${initialOptions?.sortByColumn})`);
  }
  if (initialOptions?.sortOrder !== "DESC") {
    throw new Error(`SuccessFactors page 1 returned incorrect sortOrder (expected DESC, got ${initialOptions?.sortOrder})`);
  }

  const allPostings: SuccessFactorsListingPosting[] = [];
  const seenIds = new Set<string>();

  const expectedCount1 = Math.min(pageSize, authoritativePublicJobCount);
  if (firstBatch.length !== expectedCount1) {
    throw new Error(`SuccessFactors page 1 returned ${firstBatch.length} postings, expected ${expectedCount1}`);
  }

  for (const item of firstBatch) {
    const idStr = String(item.id);
    if (seenIds.has(idStr)) {
      throw new Error(`SuccessFactors listing returned duplicate job ID ${idStr} on page 1`);
    }
    seenIds.add(idStr);
    allPostings.push(item);
  }

  // 2. Fetch ALL remaining listing pages (page 2..totalPages)
  const totalPages = Math.ceil(authoritativePublicJobCount / pageSize);
  let finalPageIsShort = false;

  for (let page = 2; page <= totalPages; page++) {
    const expectedStartRow = (page - 1) * pageSize + 1;
    const expectedCappedEndRow = Math.min(page * pageSize, authoritativePublicJobCount);
    const expectedBoundaryEndRow = page * pageSize;
    const expectedCount = expectedCappedEndRow - expectedStartRow + 1;
    const requestedEndRow = endRowMode === "ACTUAL_ROW_CAP" ? expectedCappedEndRow : expectedBoundaryEndRow;

    const searchDwrBody = [
      "callCount=1",
      `page=${encodeURIComponent(`/career?company=${identity.company}`)}`,
      `httpSessionId=${bootstrap.jsessionId}`,
      "scriptSessionId=80A8BD291A8E635A37D57F13E5D1F423100",
      "c0-scriptName=careerJobSearchControllerProxy",
      "c0-methodName=search",
      "c0-id=0",
      "c0-param0=Object_Object:{pagination:reference:c0-e1, sortByColumn:reference:c0-e2, sortOrder:reference:c0-e3}",
      `c0-e1=Object_Object:{currentPage:number:${page}, endRow:number:${requestedEndRow}, increaseCandSummaryPagination:boolean:false, pageSize:number:${pageSize}, startRow:number:${expectedStartRow}, totalCount:number:${authoritativePublicJobCount}}`,
      "c0-e2=string:JOB_POSTING_DATE",
      "c0-e3=string:DESC",
      `batchId=${page - 1}`,
    ].join("\n") + "\n";

    const pageRes = await fetchWithRetry(searchUrl, {
      method: "POST",
      headers,
      body: searchDwrBody,
    }, options);

    const pageDwrText = await pageRes.text();
    const pagePayload = parseDwrResponse(pageDwrText, String(page - 1), "0");

    const pageRecord = pagePayload as Record<string, unknown>;
    const pageOptions = (pagePayload.results?.options ?? pageRecord.options) as {
      pagination?: { currentPage?: number; pageSize?: number; startRow?: number; endRow?: number; totalCount?: number };
      sortByColumn?: string;
      sortOrder?: string;
    } | undefined;

    const pagePagination = pageOptions?.pagination;
    if (
      !pagePagination ||
      typeof pagePagination.currentPage !== "number" ||
      typeof pagePagination.pageSize !== "number" ||
      typeof pagePagination.startRow !== "number" ||
      typeof pagePagination.endRow !== "number" ||
      typeof pagePagination.totalCount !== "number"
    ) {
      throw new Error(`SuccessFactors listing returned missing or invalid pagination metadata on page ${page}`);
    }

    if (pagePagination.totalCount !== authoritativePublicJobCount) {
      throw new Error(`SuccessFactors totalCount changed mid-pagination (expected ${authoritativePublicJobCount}, got ${pagePagination.totalCount})`);
    }
    if (pagePagination.currentPage !== page) {
      throw new Error(`SuccessFactors page ${page} returned wrong currentPage: ${pagePagination.currentPage}`);
    }
    if (pagePagination.pageSize !== pageSize) {
      throw new Error(`SuccessFactors page ${page} returned changed pageSize (expected ${pageSize}, got ${pagePagination.pageSize})`);
    }
    if (pagePagination.startRow !== expectedStartRow) {
      throw new Error(`SuccessFactors page ${page} returned wrong startRow (expected ${expectedStartRow}, got ${pagePagination.startRow})`);
    }

    // Validate page endRow against established mode or valid variants
    if (endRowMode === "ACTUAL_ROW_CAP") {
      if (pagePagination.endRow !== expectedCappedEndRow) {
        throw new Error(`SuccessFactors page ${page} returned wrong endRow for mode ACTUAL_ROW_CAP (expected ${expectedCappedEndRow}, got ${pagePagination.endRow})`);
      }
    } else if (endRowMode === "PAGE_BOUNDARY") {
      if (pagePagination.endRow !== expectedBoundaryEndRow) {
        throw new Error(`SuccessFactors page ${page} returned wrong endRow for mode PAGE_BOUNDARY (expected ${expectedBoundaryEndRow}, got ${pagePagination.endRow})`);
      }
    } else {
      // If this page differentiates the two modes (i.e. expectedCappedEndRow !== expectedBoundaryEndRow)
      if (expectedCappedEndRow !== expectedBoundaryEndRow) {
        if (pagePagination.endRow === expectedCappedEndRow) {
          endRowMode = "ACTUAL_ROW_CAP";
        } else if (pagePagination.endRow === expectedBoundaryEndRow) {
          endRowMode = "PAGE_BOUNDARY";
        } else {
          throw new Error(`SuccessFactors page ${page} returned invalid endRow: ${pagePagination.endRow} (expected ${expectedCappedEndRow} or ${expectedBoundaryEndRow})`);
        }
      } else {
        // Intermediate page: both modes require page * pageSize
        if (pagePagination.endRow !== expectedBoundaryEndRow) {
          throw new Error(`SuccessFactors page ${page} returned invalid endRow: ${pagePagination.endRow} (expected ${expectedBoundaryEndRow})`);
        }
      }
    }
    if (pageOptions?.sortByColumn !== "JOB_POSTING_DATE") {
      throw new Error(`SuccessFactors page ${page} returned incorrect sortByColumn (expected JOB_POSTING_DATE, got ${pageOptions?.sortByColumn})`);
    }
    if (pageOptions?.sortOrder !== "DESC") {
      throw new Error(`SuccessFactors page ${page} returned incorrect sortOrder (expected DESC, got ${pageOptions?.sortOrder})`);
    }

    const pagePostings = pagePayload.results?.postings ?? pagePayload.postings ?? [];

    if (pagePostings.length === 0) {
      throw new Error(`SuccessFactors pagination returned empty page ${page} before reaching totalCount ${authoritativePublicJobCount}`);
    }

    if (page < totalPages) {
      // Intermediate pages MUST deliver full pageSize
      if (pagePostings.length !== pageSize) {
        throw new Error(`SuccessFactors intermediate page ${page} returned ${pagePostings.length} postings, expected ${pageSize}`);
      }
    } else {
      // Final page
      if (pagePostings.length !== expectedCount) {
        finalPageIsShort = true;
      }
    }

    const pageSeenIds = new Set<string>();
    for (const item of pagePostings) {
      const idStr = String(item.id);
      if (pageSeenIds.has(idStr)) {
        throw new Error(`SuccessFactors listing returned duplicate job ID ${idStr} within page ${page}`);
      }
      pageSeenIds.add(idStr);

      if (seenIds.has(idStr)) {
        throw new Error(`SuccessFactors listing returned duplicate job ID ${idStr} across pages`);
      }
      seenIds.add(idStr);
      allPostings.push(item);
    }
  }

  return {
    postings: allPostings,
    authoritativePublicJobCount,
    pageSize,
    finalPageIsShort,
    initialPayload,
  };
}

export async function fetchSuccessFactorsJobs(
  tokenValue: string,
  options: FetchSuccessFactorsJobsOptions = {}
): Promise<NormalizedJob[]> {
  const filterOptions: FetchSuccessFactorsJobsOptions = { usOnly: true, ...options };
  const identity = decodeSuccessFactorsToken(normalizeSuccessFactorsToken(tokenValue));
  const origin = filterOptions.originOverride ?? `https://${identity.host}`;
  const detailLimit = pLimit(filterOptions.detailConcurrency ?? 4);
  const bootstrap = await fetchBootstrap(origin, identity, filterOptions, filterOptions.originOverride);

  const trustedHosts = new Set<string>();
  trustedHosts.add(identity.host.toLowerCase());
  if (filterOptions.originOverride) {
    try {
      const originHost = new URL(filterOptions.originOverride).hostname.toLowerCase();
      if (originHost) trustedHosts.add(originHost);
    } catch {}
  }
  if (filterOptions.trustedCustomHost) {
    const custom = filterOptions.trustedCustomHost.toLowerCase().trim();
    if (custom && !HOST_PATTERN.test(custom) && !custom.includes("/") && !custom.includes(":")) {
      trustedHosts.add(custom);
    }
  }

  const searchUrl = `${origin}/xi/ajax/remoting/call/plaincall/careerJobSearchControllerProxy.search.dwr?company=${encodeURIComponent(identity.company)}${bootstrap.crb ? `&_s.crb=${encodeURIComponent(bootstrap.crb)}` : ""}`;

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=UTF-8",
    Cookie: bootstrap.cookieHeader,
    Referer: `${origin}/career?company=${encodeURIComponent(identity.company)}`,
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    viewId: bootstrap.viewId,
  };
  if (bootstrap.viewState) {
    headers["javax.faces.ViewState"] = bootstrap.viewState;
  }

  // 1. Fetch Complete Listing Snapshot 1
  const snap1 = await fetchListingSnapshot(origin, identity, bootstrap, headers, searchUrl, filterOptions);

  if (snap1.authoritativePublicJobCount === 0) {
    return [];
  }

  // Add detailURLPrefix hostname to trustedHosts ONLY if it is an absolute URL with no credentials and valid scheme
  const rawDetailPrefix = snap1.initialPayload.results?.detailURLPrefix;
  if (typeof rawDetailPrefix === "string" && rawDetailPrefix.trim().length > 0) {
    const isTest = Boolean(filterOptions.originOverride || filterOptions.allowPrivateNetworksForTests);
    try {
      // Must be an absolute URL (relative URL throws without base)
      const prefixUrl = new URL(rawDetailPrefix);
      const isHttps = prefixUrl.protocol === "https:";
      const isAllowedHttp = isTest && prefixUrl.protocol === "http:";
      if ((isHttps || isAllowedHttp) && !prefixUrl.username && !prefixUrl.password && prefixUrl.hostname) {
        trustedHosts.add(prefixUrl.hostname.toLowerCase());
      }
    } catch {
      // Relative prefixes or malformed URLs do NOT expand trustedHosts
    }
  }

  let finalPostings: SuccessFactorsListingPosting[];

  // 2. Validate Snapshot Agreement or Execute STABLE_STALE_COUNT Double Snapshot
  if (snap1.postings.length === snap1.authoritativePublicJobCount) {
    finalPostings = snap1.postings;
  } else {
    if (!filterOptions.allowStableStaleCount) {
      throw new Error(`SuccessFactors listing count mismatch (expected ${snap1.authoritativePublicJobCount}, collected ${snap1.postings.length})`);
    }

    if (!snap1.finalPageIsShort) {
      throw new Error(`SuccessFactors STABLE_STALE_COUNT mode requires count discrepancy to occur strictly on final page`);
    }

    // Immediately execute second snapshot to verify absolute stability of the count discrepancy
    const snap2 = await fetchListingSnapshot(origin, identity, bootstrap, headers, searchUrl, filterOptions);

    if (snap2.authoritativePublicJobCount !== snap1.authoritativePublicJobCount) {
      throw new Error(`SuccessFactors STABLE_STALE_COUNT mode detected advertised totalCount change between snapshots (snap1: ${snap1.authoritativePublicJobCount}, snap2: ${snap2.authoritativePublicJobCount})`);
    }
    if (snap2.postings.length !== snap1.postings.length) {
      throw new Error(`SuccessFactors STABLE_STALE_COUNT mode detected posting count change between snapshots (snap1: ${snap1.postings.length}, snap2: ${snap2.postings.length})`);
    }

    for (let i = 0; i < snap1.postings.length; i++) {
      if (String(snap1.postings[i].id) !== String(snap2.postings[i].id)) {
        throw new Error(`SuccessFactors STABLE_STALE_COUNT mode detected ID sequence divergence at index ${i} (${snap1.postings[i].id} vs ${snap2.postings[i].id})`);
      }
    }

    finalPostings = snap1.postings;
  }

  // 3. Detail Retrieval & Persistence Slicing (maxJobs applies ONLY to targetDrafts details)
  const draftJobs: NormalizedJob[] = finalPostings.map((item) => ({
    externalId: String(item.id),
    title: item.title?.trim() || "",
    location: extractLocationFromPosting(item),
    department: null,
    url: `${origin}/career?career_ns=job_listing&company=${encodeURIComponent(identity.company)}&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&career_job_req_id=${item.id}`,
    descriptionHtml: "",
    descriptionText: "",
    employmentType: null,
    workplaceType: null,
    salaryText: null,
    postedAt: parsePostingDate(item.postingDate),
    raw: { identity, posting: item },
  }));

  const eligibleDrafts = filterOptions.usOnly
    ? draftJobs.filter((j) => classifyJobLocation(j.location) !== "NON_US")
    : draftJobs;
  const targetDrafts = filterOptions.maxJobs ? eligibleDrafts.slice(0, filterOptions.maxJobs) : eligibleDrafts;

  const postingMap = new Map(finalPostings.map((p) => [String(p.id), p]));
  const immutableTrustedHosts: ReadonlySet<string> = new Set(trustedHosts);

  const detailedJobs = await Promise.all(
    targetDrafts.map((draft) =>
      detailLimit(async () => {
        // Deliberately NOT wrapped in a graceful-degradation catch, unlike SmartRecruiters/Workday's
        // per-job fallback: this adapter's own hardened test suite (ported below) requires a detail
        // fetch that redirects toward an untrusted/credential-bearing host to fail the WHOLE scan,
        // even when that redirect manifests as a raw network-transport error rather than a clean
        // validateDetailResponseUrl rejection — there is no reliable way to distinguish "a malicious
        // redirect that happened to also be unreachable" from "a benign transient network blip" from
        // outside the fetch call. Given this adapter's unusually high security sensitivity (RCE-safe
        // DWR parsing, tenant-identity spoofing protection, credential-bearing-redirect protection),
        // preserving that fully-tested fail-closed behavior exactly takes priority over the milder
        // per-job resilience improvement applied to the other adapters.
        if (!draft.externalId) throw new Error("Missing external ID on draft job");
        const posting = postingMap.get(draft.externalId);
        if (!posting) throw new Error(`Missing posting metadata for job ${draft.externalId}`);

        const detailUrl = `${origin}/career?career_ns=job_listing&company=${encodeURIComponent(identity.company)}&navBarLevel=JOB_SEARCH&rcm_site_locale=en_US&career_job_req_id=${draft.externalId}`;
        const detailRes = await fetchWithRetry(detailUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        }, filterOptions);

        const detailHtml = await detailRes.text();
        return parseJobDetail(detailHtml, posting, identity, origin, immutableTrustedHosts, detailRes.url);
      })
    )
  );

  return filterJobsToUs(detailedJobs, filterOptions);
}
