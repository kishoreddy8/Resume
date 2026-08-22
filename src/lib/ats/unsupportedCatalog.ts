export interface UnsupportedAtsSignature {
  name: string;
  /** Exact/anchored hostname test. Paths are checked separately to avoid classifying vendor legal,
   * marketing, or JavaScript-asset URLs as employer job boards. */
  hostname: RegExp;
  path?: RegExp;
  excludePath?: RegExp;
}

/**
 * Recognized hosted ATS products for which CareerOps does not yet have a job connector.
 * This is discovery metadata, not an approval list: a match becomes NEEDS_ADAPTER and can never
 * load jobs until a provider adapter and company-specific validation are complete.
 */
export const UNSUPPORTED_ATS_SIGNATURES: readonly UnsupportedAtsSignature[] = [
  { name: "Dayforce", hostname: /^(?:jobs\.)?dayforcehcm\.com$/i, path: /\/(?:CandidatePortal|mydayforce|jobs)(?:\/|$)/i },
  { name: "Phenom", hostname: /^(?!cdn\.)(?:[a-z0-9-]+\.)+phenompeople\.com$/i },
  { name: "Avature", hostname: /^[a-z0-9.-]+\.avature\.(?:net|com)$/i },
  { name: "Personio", hostname: /^[a-z0-9.-]+\.jobs\.personio\.com$/i },
  { name: "Zoho Recruit", hostname: /^careers\.zohorecruit\.(?:com|eu|in)$/i, path: /\/jobs\//i },
  { name: "Fountain", hostname: /^(?:[a-z0-9-]+\.)?fountain\.com$/i, path: /\/jobs?(?:\/|$)/i },
  { name: "PeopleFluent", hostname: /^[a-z0-9.-]+\.peoplefluent\.com$/i, path: /\/(?:res_joblist|career)(?:\/|$)/i },
  { name: "Bullhorn", hostname: /^[a-z0-9.-]+\.bullhornstaffing\.com$/i, path: /\/JobBoard(?:\/|$)/i },
  { name: "Hirebridge", hostname: /^(?:www\.)?hirebridge\.com$/i, path: /\/jobseeker\d*\/jobs?/i },
  { name: "isolved Talent Acquisition", hostname: /^jobs\.ourcareerpages\.com$/i },
  { name: "Eddy", hostname: /^apply\.eddy\.com$/i },
  { name: "Homerun", hostname: /^[a-z0-9.-]+\.homerun\.co$/i, path: /\/jobs?(?:\/|$)/i },
  { name: "Manatal", hostname: /^careers\.manatal\.com$/i },
  { name: "Trakstar Hire", hostname: /^hire\.trakstar\.com$/i },
  { name: "Workstream", hostname: /^apply\.workstream\.us$/i },
] as const;

export function detectUnsupportedAtsUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.replace(/&amp;/gi, "&"));
  } catch {
    return null;
  }
  const pathAndQuery = `${url.pathname}${url.search}`;
  for (const signature of UNSUPPORTED_ATS_SIGNATURES) {
    if (!signature.hostname.test(url.hostname)) continue;
    if (signature.excludePath?.test(pathAndQuery)) continue;
    if (signature.path && !signature.path.test(pathAndQuery)) continue;
    return signature.name;
  }
  return null;
}

export function isKnownVendorAssetFalsePositive(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.replace(/&amp;/gi, "&"));
  } catch {
    return false;
  }
  const path = url.pathname;
  return (
    (url.hostname === "www.icims.com" && /\/(?:legal|privacy)(?:\/|$)/i.test(path)) ||
    (/\.successfactors\.(?:com|eu)$/i.test(url.hostname) && /\/(?:verp|ui\/extlib|assets?)\//i.test(path)) ||
    (/\.successfactors\.(?:com|eu)$/i.test(url.hostname) && /\.(?:js|css|png|jpe?g|gif|svg|pdf)(?:$|[?&#%])/i.test(`${path}${url.search}`)) ||
    url.hostname === "cdn.phenompeople.com" ||
    (url.hostname === "jobs.jobvite.com" && /^\/__assets__(?:\/|$)/i.test(path)) ||
    (url.hostname === "workforcenow.adp.com" && /\/recwebcomponents\/.*\.(?:js|css)(?:$|[?&#%])/i.test(`${path}${url.search}`))
  );
}
