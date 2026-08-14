import { encodeWorkdayToken } from "@/lib/ats/workday";
import { canonicalAdpWorkforceNowUrl, encodeAdpWorkforceNowToken } from "@/lib/ats/adpWorkforceNow";
import { canonicalPaylocityUrl, encodePaylocityToken } from "@/lib/ats/paylocity";
import { canonicalIcimsUrl, normalizeIcimsHost } from "@/lib/ats/icims";
import { canonicalUkgProUrl, encodeUkgProToken } from "@/lib/ats/ukgPro";
import { canonicalBambooHrUrl, normalizeBambooHrTenant } from "@/lib/ats/bamboohr";
import { canonicalOracleRecruitingCloudUrl, encodeOracleRecruitingCloudToken } from "@/lib/ats/oracleRecruitingCloud";
import { canonicalWorkableUrl, normalizeWorkableSlug } from "@/lib/ats/workable";
import { canonicalRipplingUrl, normalizeRipplingSlug } from "@/lib/ats/rippling";
import { canonicalPaycomUrl, normalizePaycomClientKey } from "@/lib/ats/paycom";
import { canonicalJazzHrUrl, normalizeJazzHrTenant } from "@/lib/ats/jazzhr";
import { canonicalJobviteUrl, normalizeJobviteTenant } from "@/lib/ats/jobvite";
import { canonicalBreezyUrl, normalizeBreezyTenant } from "@/lib/ats/breezy";
import { canonicalTeamtailorUrl, normalizeTeamtailorTenant } from "@/lib/ats/teamtailor";
import { canonicalApplicantProUrl, normalizeApplicantProTenant } from "@/lib/ats/applicantpro";
import { canonicalPinpointUrl, normalizePinpointTenant } from "@/lib/ats/pinpoint";
import { canonicalPersonioUrl, normalizePersonioTenant } from "@/lib/ats/personio";
import { canonicalApplicantStackUrl, normalizeApplicantStackTenant } from "@/lib/ats/applicantstack";
import { canonicalComeetUrl, normalizeComeetToken } from "@/lib/ats/comeet";
import { canonicalCatsUrl, normalizeCatsToken } from "@/lib/ats/cats";
import { canonicalGoHireUrl, normalizeGoHireToken } from "@/lib/ats/gohire";
import { canonicalNewtonUrl, normalizeNewtonClientId } from "@/lib/ats/newton";
import { canonicalSilkRoadUrl, normalizeSilkRoadToken } from "@/lib/ats/silkroad";
import { canonicalJobDivaUrl, normalizeJobDivaToken } from "@/lib/ats/jobdiva";
import { canonicalTaleoUrl, normalizeTaleoToken } from "@/lib/ats/taleo";
import { canonicalAdpRmUrl, normalizeAdpRmToken } from "@/lib/ats/adpRecruitingManagement";
import { canonicalEightfoldUrl, normalizeEightfoldToken } from "@/lib/ats/eightfold";
import { canonicalCornerstoneUrl, normalizeCornerstoneToken } from "@/lib/ats/cornerstone";
import { canonicalAvatureUrl, normalizeAvatureToken } from "@/lib/ats/avature";
import { canonicalClearCompanyUrl, normalizeClearCompanyTenant } from "@/lib/ats/clearcompany";
import { canonicalSmartRecruitersUrl, normalizeSmartRecruitersToken } from "@/lib/ats/smartrecruiters";
import type { SourceType } from "@/types";

export interface AtsDetection {
  sourceType: Exclude<SourceType, "career_link">;
  atsBoardToken: string;
  /** Stable board root when the matched URL may point at an individual job or apply page. */
  canonicalSourceUrl?: string;
}

const LOCALE_SEGMENT = /^[a-z]{2}-[A-Z]{2}$/;

function detectGreenhouse(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(value.replace(/&amp;/gi, "&"));
  } catch {
    return null;
  }
  if (!/^(?:boards|job-boards)\.greenhouse\.io$/i.test(url.hostname)) return null;
  const firstSegment = url.pathname.split("/").filter(Boolean)[0];
  const token = firstSegment === "embed" ? url.searchParams.get("for") : firstSegment;
  if (!token || !/^[a-z0-9_-]+$/i.test(token)) return null;
  return {
    sourceType: "greenhouse",
    atsBoardToken: token,
    canonicalSourceUrl: firstSegment === "embed"
      ? `https://job-boards.greenhouse.io/${token}`
      : `${url.origin}/${token}`,
  };
}

function detectWorkday(url: string): AtsDetection | null {
  const match = url.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/([^?#]*)/i);
  if (!match) return null;
  const [, tenant, host, rest] = match;
  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const site = LOCALE_SEGMENT.test(segments[0]) ? segments[1] : segments[0];
  if (!site) return null;
  return {
    sourceType: "workday",
    atsBoardToken: encodeWorkdayToken({ tenant: tenant.toLowerCase(), host: host.toLowerCase(), site }),
    canonicalSourceUrl: `https://${tenant.toLowerCase()}.${host.toLowerCase()}.myworkdayjobs.com/${site}`,
  };
}

function detectSmartRecruiters(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^(?:jobs|careers)\.smartrecruiters\.com$/i.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const rawToken = segments[0];
  if (!rawToken) return null;
  let token: string;
  try {
    token = normalizeSmartRecruitersToken(rawToken);
  } catch {
    return null;
  }
  return {
    sourceType: "smartrecruiters",
    atsBoardToken: token,
    canonicalSourceUrl: canonicalSmartRecruitersUrl(token),
  };
}

function decodeSavedUrl(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/gi, "&")
    .replace(/&#x0*26;/gi, "&")
    .replace(/&#0*34;/gi, '"');
}

function detectAdpWorkforceNow(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "workforcenow.adp.com") return null;
  if (!/\/mascsr\/default\/mdf\/recruitment\/(?:recruitment|intermediateRedirect)\.html$/i.test(url.pathname)) return null;
  const cid = url.searchParams.get("cid")?.trim();
  const ccId = url.searchParams.get("ccId")?.trim() || "19000101_000001";
  const lang = url.searchParams.get("lang")?.trim() || "en_US";
  if (!cid || !/^[a-f0-9-]{36}$/i.test(cid)) return null;
  const token = encodeAdpWorkforceNowToken({ cid, ccId, lang });
  return {
    sourceType: "adp_wfn",
    atsBoardToken: token,
    canonicalSourceUrl: canonicalAdpWorkforceNowUrl(token),
  };
}

function detectPaylocity(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "recruiting.paylocity.com") return null;
  const match = url.pathname.match(/^\/recruiting\/jobs\/All\/([a-f0-9-]{36})(?:\/([a-z0-9_-]+))?\/?$/i);
  if (!match) return null;
  const slug = match[2] || "_";
  const token = encodePaylocityToken({ companyId: match[1], slug });
  return { sourceType: "paylocity", atsBoardToken: token, canonicalSourceUrl: canonicalPaylocityUrl(token) };
}

function detectIcims(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^(?!www\.)[a-z0-9.-]+\.icims\.com$/i.test(url.hostname)) return null;
  if (url.pathname !== "/" && url.pathname !== "" && !/^\/jobs?(?:\/|$)/i.test(url.pathname)) return null;
  const token = normalizeIcimsHost(url.hostname);
  return { sourceType: "icims", atsBoardToken: token, canonicalSourceUrl: canonicalIcimsUrl(token) };
}

function detectUkgPro(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^recruiting2?\.ultipro\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/([a-z0-9]+)\/JobBoard\/([a-f0-9-]{36})(?:\/|$)/i);
  if (!match) return null;
  const token = encodeUkgProToken({
    host: url.hostname.toLowerCase() as "recruiting.ultipro.com" | "recruiting2.ultipro.com",
    tenant: match[1],
    boardId: match[2],
  });
  return { sourceType: "ukg_pro", atsBoardToken: token, canonicalSourceUrl: canonicalUkgProUrl(token) };
}

function detectBambooHr(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  const match = url.hostname.match(/^([a-z0-9-]+)\.bamboohr\.com$/i);
  if (!match || !/^\/careers(?:\/\d+)?\/?$/i.test(url.pathname)) return null;
  const token = normalizeBambooHrTenant(match[1]);
  return { sourceType: "bamboohr", atsBoardToken: token, canonicalSourceUrl: canonicalBambooHrUrl(token) };
}

function detectOracleRecruitingCloud(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+\.oraclecloud\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/hcmUI\/CandidateExperience\/[a-z]{2}\/sites\/([a-z0-9_-]+)/i);
  if (!match) return null;
  const token = encodeOracleRecruitingCloudToken({ host: url.hostname, site: match[1] });
  return {
    sourceType: "oracle_recruiting_cloud",
    atsBoardToken: token,
    canonicalSourceUrl: canonicalOracleRecruitingCloudUrl(token),
  };
}

function detectWorkable(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "apply.workable.com" || hostname === "jobs.workable.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    const slug = parts[0] === "company" ? parts[1] : parts[0];
    if (!slug || /^(?:j|api)$/i.test(slug)) return null;
    try {
      const token = normalizeWorkableSlug(slug);
      return { sourceType: "workable", atsBoardToken: token, canonicalSourceUrl: canonicalWorkableUrl(token) };
    } catch {
      return null;
    }
  }
  if (hostname.endsWith(".workable.com")) {
    const sub = hostname.split(".")[0];
    if (sub && !/^(?:apply|jobs|www|api)$/i.test(sub)) {
      try {
        const token = normalizeWorkableSlug(sub);
        return { sourceType: "workable", atsBoardToken: token, canonicalSourceUrl: canonicalWorkableUrl(token) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

function detectRippling(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^ats(?:\.us1)?\.rippling\.com$/i.test(url.hostname)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "embed") segments.shift();
  if (/^[a-z]{2}-[a-z]{2}$/i.test(segments[0] ?? "")) segments.shift();
  const [rawSlug, jobsSegment, detailId] = segments;
  if (!rawSlug || jobsSegment?.toLowerCase() !== "jobs") return null;
  if (detailId && !/^[0-9a-f-]{36}$/i.test(detailId)) return null;
  const token = normalizeRipplingSlug(rawSlug);
  return { sourceType: "rippling", atsBoardToken: token, canonicalSourceUrl: canonicalRipplingUrl(token) };
}

function detectPaycom(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (!/^(?:www\.)?paycomonline\.net$/i.test(url.hostname)) return null;
  if (!/^\/v4\/ats\/web\.php\/jobs(?:\/\d+)?\/?$/i.test(url.pathname)) return null;
  const clientKey = url.searchParams.get("clientkey");
  if (!clientKey) return null;
  const token = normalizePaycomClientKey(clientKey);
  return { sourceType: "paycom", atsBoardToken: token, canonicalSourceUrl: canonicalPaycomUrl(token) };
}

function detectJazzHr(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  const hostMatch = url.hostname.match(/^([a-z0-9-]+)\.applytojob\.com$/i);
  if (!hostMatch || !/^\/apply(?:\/?$|\/[a-z0-9]{10}(?:\/|$))/i.test(url.pathname)) return null;
  const token = normalizeJazzHrTenant(hostMatch[1]);
  return { sourceType: "jazzhr", atsBoardToken: token, canonicalSourceUrl: canonicalJazzHrUrl(token) };
}

function detectJobvite(value: string): AtsDetection | null {
  let url: URL;
  try {
    url = new URL(decodeSavedUrl(value));
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "jobs.jobvite.com") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() === "careers") segments.shift();
  const tenant = segments[0];
  if (!tenant || /^(?:__assets__|images|scripts|styles|fonts|api)$/i.test(tenant)) return null;
  let token: string;
  try {
    token = normalizeJobviteTenant(tenant);
  } catch {
    return null;
  }
  return { sourceType: "jobvite", atsBoardToken: token, canonicalSourceUrl: canonicalJobviteUrl(token) };
}

function detectBreezy(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.breezy\.hr$/i);
  if (!match || !/^\/(?:$|p\/[a-f0-9]{12}(?:-[^/?#]+)?(?:\/|$))/i.test(url.pathname)) return null;
  const token = normalizeBreezyTenant(match[1]);
  return { sourceType: "breezy", atsBoardToken: token, canonicalSourceUrl: canonicalBreezyUrl(token) };
}

function detectTeamtailor(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.teamtailor\.com$/i);
  if (!match || !/^\/jobs(?:\/\d+(?:-[^/?#]+)?)?\/?$/i.test(url.pathname)) return null;
  const token = normalizeTeamtailorTenant(match[1]);
  return { sourceType: "teamtailor", atsBoardToken: token, canonicalSourceUrl: canonicalTeamtailorUrl(token) };
}

function detectApplicantPro(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  let rawTenant: string | undefined;
  if (url.hostname.toLowerCase() === "www.applicantpro.com") {
    rawTenant = url.pathname.match(/^\/openings\/([a-z0-9-]+)\/jobs(?:\/\d+(?:\/[^?#]*)?)?\/?$/i)?.[1];
  } else {
    const host = url.hostname.match(/^([a-z0-9-]+)\.applicantpro\.com$/i);
    if (host && /^\/jobs(?:\/\d+(?:-\d+)?(?:\.html)?)?\/?$/i.test(url.pathname)) rawTenant = host[1];
  }
  if (!rawTenant) return null;
  const token = normalizeApplicantProTenant(rawTenant);
  return { sourceType: "applicantpro", atsBoardToken: token, canonicalSourceUrl: canonicalApplicantProUrl(token) };
}

function detectPinpoint(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.pinpointhq\.com$/i);
  if (!match || !/^\/(?:$|[a-z]{2}\/?$|(?:[a-z]{2}\/)?postings\/[a-f0-9-]{36}\/?$)/i.test(url.pathname)) return null;
  const token = normalizePinpointTenant(match[1]);
  return { sourceType: "pinpoint", atsBoardToken: token, canonicalSourceUrl: canonicalPinpointUrl(token) };
}

function detectClearCompany(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.clearcompany\.com$/i);
  if (!match || !/^\/careers\/(?:portal|jobs(?:\/[a-f0-9-]{36}(?:\/apply)?)?)\/?$/i.test(url.pathname)) return null;
  const token = normalizeClearCompanyTenant(match[1]);
  return { sourceType: "clearcompany", atsBoardToken: token, canonicalSourceUrl: canonicalClearCompanyUrl(token) };
}

function detectPersonio(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.jobs\.personio\.de$/i);
  if (!match || !/^\/(?:$|job\/\d+\/?$)/i.test(url.pathname)) return null;
  const token = normalizePersonioTenant(match[1]);
  return { sourceType: "personio", atsBoardToken: token, canonicalSourceUrl: canonicalPersonioUrl(token) };
}

function detectApplicantStack(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  const match = url.hostname.match(/^([a-z0-9-]+)\.applicantstack\.com$/i);
  if (!match || !/^\/x\/(?:openings|detail\/[a-z0-9]+|apply\/[a-z0-9]+)\/?$/i.test(url.pathname)) return null;
  const token = normalizeApplicantStackTenant(match[1]);
  return { sourceType: "applicantstack", atsBoardToken: token, canonicalSourceUrl: canonicalApplicantStackUrl(token) };
}

function detectComeet(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (url.hostname.toLowerCase() !== "www.comeet.com") return null;
  const match = url.pathname.match(/^\/jobs\/([a-z0-9-]+)\/([a-z0-9.]+)(?:\/[^/]+\/[a-z0-9.]+)?\/?$/i);
  if (!match) return null;
  const token = normalizeComeetToken(`${match[1]}|${match[2]}`);
  return { sourceType: "comeet", atsBoardToken: token, canonicalSourceUrl: canonicalComeetUrl(token) };
}

function detectCats(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^[a-z0-9-]+\.catsone\.com$/i.test(url.hostname)) return null;
  const portal = url.pathname.match(/^\/careers\/(\d+)(?:-[^/]+)?(?:\/(?:register|jobs\/\d+-[^/]+(?:\/apply)?))?\/?$/i)?.[1];
  if (!portal) return null;
  const token = normalizeCatsToken(`${url.hostname}|${portal}`);
  return { sourceType: "cats", atsBoardToken: token, canonicalSourceUrl: canonicalCatsUrl(token) };
}

function detectGoHire(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (url.hostname.toLowerCase() !== "widget.gohire.io") return null;
  const clientHash = url.pathname.match(/^\/widget\/([A-Za-z0-9]{8})\/?$/)?.[1];
  if (!clientHash) return null;
  const token = normalizeGoHireToken(clientHash);
  return { sourceType: "gohire", atsBoardToken: token, canonicalSourceUrl: canonicalGoHireUrl(token) };
}

function detectNewton(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^(?:newton\.newtonsoftware\.com|recruitingbypaycor\.com)$/i.test(url.hostname)
    || !/^\/career\/(?:iframe|CareerHome|CareerHomeSearch|JobIntroduction|SubmitResume)\.action$/i.test(url.pathname)) return null;
  const clientId = url.searchParams.get("clientId");
  if (!clientId) return null;
  const token = normalizeNewtonClientId(clientId);
  return { sourceType: "newton", atsBoardToken: token, canonicalSourceUrl: canonicalNewtonUrl(token) };
}

function detectSilkRoad(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (url.hostname.toLowerCase() !== "jobs.silkroad.com") return null;
  const match = url.pathname.match(/^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/jobs\/\d+|\/Apply\/(?:MultiForm\/\d+|QuickApply\/0))?\/?$/i);
  if (!match) return null;
  const token = normalizeSilkRoadToken(`${match[1]}|${match[2]}`);
  return { sourceType: "silkroad", atsBoardToken: token, canonicalSourceUrl: canonicalSilkRoadUrl(token) };
}

function detectJobDiva(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^www\d*\.jobdiva\.com$/i.test(url.hostname) || !/^\/portal\/?$/i.test(url.pathname)) return null;
  const account = url.searchParams.get("a")?.toLowerCase();
  const compids = url.searchParams.getAll("compid");
  const compid = compids.at(-1) || "-1";
  let divisions = url.searchParams.get("divisions") ?? "";
  if (!divisions && url.hash.includes("?")) divisions = new URLSearchParams(url.hash.slice(url.hash.indexOf("?") + 1)).get("divisions") ?? "";
  try {
    const token = normalizeJobDivaToken(`${url.hostname}|${account ?? ""}|${compid}|${divisions}`);
    return { sourceType: "jobdiva", atsBoardToken: token, canonicalSourceUrl: canonicalJobDivaUrl(token) };
  } catch { return null; }
}

function detectTaleo(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^[a-z0-9-]+\.taleo\.net$/i.test(url.hostname)) return null;
  const directSection = url.pathname.match(/^\/careersection\/([a-z0-9_-]+)\/(?:jobsearch|jobdetail|moresearch)\.ftl$/i)?.[1];
  let section = directSection;
  if (!section && /^\/careersection\/iam\/accessmanagement\/login\.jsf$/i.test(url.pathname)) {
    for (const key of ["redirectionURI", "TARGET"]) {
      const nestedValue = url.searchParams.get(key); if (!nestedValue) continue;
      try {
        const nested = new URL(nestedValue);
        if (nested.hostname.toLowerCase() !== url.hostname.toLowerCase()) continue;
        section = nested.pathname.match(/^\/careersection\/([a-z0-9_-]+)\/(?:jobsearch|jobdetail|moresearch)\.ftl$/i)?.[1];
        if (section) break;
      } catch { /* try the next saved redirect value */ }
    }
  }
  if (!section || /^(?:iam|rest|theme)$/i.test(section)) return null;
  try {
    const token = normalizeTaleoToken(`${url.hostname}|${section}`);
    return { sourceType: "taleo", atsBoardToken: token, canonicalSourceUrl: canonicalTaleoUrl(token) };
  } catch { return null; }
}

function detectAdpRecruitingManagement(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (url.hostname.toLowerCase() !== "myjobs.adp.com") return null;
  const slug = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug) || ["public", "api", "static", "cx", "assets"].includes(slug)) return null;
  const siteId = url.searchParams.get("siteId");
  const orgoid = url.searchParams.get("orgoid");
  const clientId = url.searchParams.get("clientId");
  if (siteId && orgoid && clientId) {
    try {
      const token = normalizeAdpRmToken(`${slug}|${siteId}|${orgoid}|${clientId}`);
      return { sourceType: "adp_rm", atsBoardToken: token, canonicalSourceUrl: canonicalAdpRmUrl(token) };
    } catch {
      // Fall back to slug detection
    }
  }
  return {
    sourceType: "adp_rm",
    atsBoardToken: slug,
    canonicalSourceUrl: `https://myjobs.adp.com/${slug}`,
  };
}

function detectEightfold(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^[a-z0-9.-]+\.eightfold\.ai$/i.test(url.hostname) || !/^\/careers(?:\/job\/\d+)?\/?$/i.test(url.pathname)) return null;
  const domain = url.searchParams.get("domain"); if (!domain) return null;
  try { const token = normalizeEightfoldToken(`${url.hostname}|${domain}`);
    return { sourceType: "eightfold", atsBoardToken: token, canonicalSourceUrl: canonicalEightfoldUrl(token) };
  } catch { return null; }
}

function detectCornerstone(value: string): AtsDetection | null {
  let url: URL;
  try { url = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^[a-z0-9.-]+\.csod\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/ux\/ats\/careersite\/(\d+)\/home(?:\/requisition\/\d+)?\/?$/i);
  const corp = url.searchParams.get("c");
  if (!match || !corp) return null;
  try { const token = normalizeCornerstoneToken(`${url.hostname}|${match[1]}|${corp}`);
    return { sourceType: "cornerstone", atsBoardToken: token, canonicalSourceUrl: canonicalCornerstoneUrl(token) };
  } catch { return null; }
}

function detectAvature(value: string): AtsDetection | null {
  let parsed: URL; try { parsed = new URL(decodeSavedUrl(value)); } catch { return null; }
  if (!/^[a-z0-9.-]+\.avature\.(?:net|com)$/i.test(parsed.hostname)) return null;
  let raw: string | null = null;
  const template = parsed.pathname.match(/^\/([^/]+)\/(Job-Search[_a-z0-9-]*)\/?$/i);
  const legacy = parsed.pathname.match(/^\/([a-z]{2}_[A-Z]{2}\/careers)(?:\/SearchJobs)?\/?$/);
  if (template) raw = `${parsed.hostname}|template|${template[1]}|${template[2]}`;
  else if (legacy) raw = `${parsed.hostname}|legacy|${legacy[1]}|SearchJobs`;
  if (!raw) return null;
  try { const token = normalizeAvatureToken(raw);
    return { sourceType: "avature", atsBoardToken: token, canonicalSourceUrl: canonicalAvatureUrl(token) };
  } catch { return null; }
}

// Order matters only in that each pattern is tried in turn; a URL should never match more than one.
const SIMPLE_PATTERNS: { sourceType: Exclude<SourceType, "career_link" | "workday">; pattern: RegExp }[] = [
  { sourceType: "ashby", pattern: /jobs\.ashbyhq\.com\/([^/?#]+)/i },
  { sourceType: "lever", pattern: /jobs\.lever\.co\/([^/?#]+)/i },
];

/** Tier 1: cheap, no network — matches known ATS domain patterns directly in a URL string. */
export function detectAtsFromUrlString(url: string): AtsDetection | null {
  const workday = detectWorkday(url);
  if (workday) return workday;
  const greenhouse = detectGreenhouse(url);
  if (greenhouse) return greenhouse;
  const smartRecruiters = detectSmartRecruiters(url);
  if (smartRecruiters) return smartRecruiters;
  const adpWorkforceNow = detectAdpWorkforceNow(url);
  if (adpWorkforceNow) return adpWorkforceNow;
  const paylocity = detectPaylocity(url);
  if (paylocity) return paylocity;
  const icims = detectIcims(url);
  if (icims) return icims;
  const ukgPro = detectUkgPro(url);
  if (ukgPro) return ukgPro;
  const bambooHr = detectBambooHr(url);
  if (bambooHr) return bambooHr;
  const oracle = detectOracleRecruitingCloud(url);
  if (oracle) return oracle;
  const workable = detectWorkable(url);
  if (workable) return workable;
  const rippling = detectRippling(url);
  if (rippling) return rippling;
  const paycom = detectPaycom(url);
  if (paycom) return paycom;
  const jazzHr = detectJazzHr(url);
  if (jazzHr) return jazzHr;
  const jobvite = detectJobvite(url);
  if (jobvite) return jobvite;
  const breezy = detectBreezy(url);
  if (breezy) return breezy;
  const teamtailor = detectTeamtailor(url);
  if (teamtailor) return teamtailor;
  const applicantPro = detectApplicantPro(url);
  if (applicantPro) return applicantPro;
  const pinpoint = detectPinpoint(url);
  if (pinpoint) return pinpoint;
  const clearCompany = detectClearCompany(url);
  if (clearCompany) return clearCompany;
  const personio = detectPersonio(url);
  if (personio) return personio;
  const applicantStack = detectApplicantStack(url);
  if (applicantStack) return applicantStack;
  const comeet = detectComeet(url);
  if (comeet) return comeet;
  const cats = detectCats(url);
  if (cats) return cats;
  const gohire = detectGoHire(url);
  if (gohire) return gohire;
  const newton = detectNewton(url);
  if (newton) return newton;
  const silkroad = detectSilkRoad(url);
  if (silkroad) return silkroad;
  const jobdiva = detectJobDiva(url);
  if (jobdiva) return jobdiva;
  const taleo = detectTaleo(url);
  if (taleo) return taleo;
  const adpRm = detectAdpRecruitingManagement(url);
  if (adpRm) return adpRm;
  const eightfold = detectEightfold(url);
  if (eightfold) return eightfold;
  const cornerstone = detectCornerstone(url);
  if (cornerstone) return cornerstone;
  const avature = detectAvature(url);
  if (avature) return avature;

  for (const { sourceType, pattern } of SIMPLE_PATTERNS) {
    const match = url.match(pattern);
    if (match) return { sourceType, atsBoardToken: match[1] };
  }
  return null;
}

// Tier 2 (multi-hop, network-based detection for a custom domain that proxies/redirects to an ATS)
// used to live here as detectAtsFromUrl(), calling raw fetch() with no SSRF protection, no response
// size cap, and only ever following ONE hop. It has been replaced by the bounded, SSRF-safe
// discovery chain in src/lib/ats/discovery.ts (discoverCompanySource), which reuses
// detectAtsFromUrlString above at every hop instead of duplicating this logic. See AGENTS.md §9-14.
