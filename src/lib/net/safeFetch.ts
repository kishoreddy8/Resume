import dns from "node:dns";

/**
 * SSRF-safe fetch — the shared foundation for the ATS discovery pipeline (see AGENTS.md §10/§11).
 * Every discovery hop (homepage -> careers link -> search-jobs link -> ...) goes through this, never
 * a raw fetch(). Blocks: non-http(s) schemes, localhost/loopback, private/link-local/reserved IP
 * ranges (including DNS-rebinding — a hostname that *resolves* to one of those ranges is rejected
 * just as much as a literal IP), unsafe/excessive/looping redirects, and oversized responses.
 *
 * Redirect destinations are revalidated with the exact same checks as the original URL — a server
 * that redirects to http://169.254.169.254/ (cloud metadata) or http://localhost/admin is rejected at
 * the redirect hop, not just at the start.
 */

export type SafeFetchErrorReason =
  | "invalid_url"
  | "disallowed_scheme"
  | "disallowed_host"
  // Temporary resolver failure (network blip, resolver timeout, SERVFAIL-like condition) — worth
  // retrying later. Distinct from dns_hostname_not_found below; see classifyDnsLookupError.
  | "dns_resolution_failed"
  // The resolver authoritatively reports no such host (NXDOMAIN/ENOTFOUND/ENODATA, or a lookup that
  // succeeded but returned zero addresses) — retrying the identical hostname will produce the
  // identical result. Callers must treat this as HARD/non-retryable, never bucketed with transient
  // failures — see discovery.ts's/verifyDomain.ts's TRANSIENT_*REASONS sets, which deliberately
  // exclude this one.
  | "dns_hostname_not_found"
  | "too_many_redirects"
  | "redirect_loop"
  | "missing_redirect_location"
  | "response_too_large"
  | "timeout"
  | "network_error";

export class SafeFetchError extends Error {
  reason: SafeFetchErrorReason;
  constructor(reason: SafeFetchErrorReason, message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.reason = reason;
  }
}

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Test-only escape hatch: skips the private/loopback/link-local IP checks so tests can run
   *  against a local HTTP server. NEVER set true from discovery.ts or any production call site —
   *  the whole point of this module is that production discovery cannot opt out of this check. */
  allowPrivateNetworksForTests?: boolean;
}

export interface SafeFetchResult {
  status: number;
  finalUrl: string;
  headers: Headers;
  bodyText: string;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// --- IPv4/IPv6 private/loopback/link-local/reserved range checks -------------------------------

function ipv4ToInt(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Range(ip: number, base: string, prefixLength: number): boolean {
  const baseParts = base.split(".").map(Number);
  const baseInt = ipv4ToInt(baseParts);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/** True for 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
 *  192.168.0.0/16, 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4 (multicast), 240.0.0.0/4 (reserved). */
export function isDisallowedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed = disallowed
  const ip = ipv4ToInt(parts);
  const ranges: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return ranges.some(([base, prefix]) => inIpv4Range(ip, base, prefix));
}

/** True for ::1 (loopback), :: (unspecified), fe80::/10 (link-local), fc00::/7 (unique local),
 *  ff00::/8 (multicast), and IPv4-mapped (::ffff:a.b.c.d) addresses whose embedded IPv4 is itself
 *  disallowed. Conservative on anything that fails to parse. */
export function isDisallowedIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDisallowedIPv4(mapped[1]);
  const firstHextet = normalized.split(":").find((seg) => seg.length > 0) ?? "";
  const value = parseInt(firstHextet, 16);
  if (Number.isNaN(value)) return true;
  if ((value & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((value & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((value & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isDisallowedIp(address: string, family: 4 | 6): boolean {
  return family === 4 ? isDisallowedIPv4(address) : isDisallowedIPv6(address);
}

const DISALLOWED_HOSTNAME_LITERALS = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/** Node's dns.promises.lookup (getaddrinfo under the hood) throws a SystemError-shaped object with a
 *  `.code` — ENOTFOUND/ENODATA mean the resolver authoritatively found no such host (equivalent to
 *  NXDOMAIN for our purposes): retrying the identical hostname will never succeed, so this must be
 *  classified as HARD, not transient. Everything else (EAI_AGAIN — temporary failure in name
 *  resolution, ETIMEDOUT, or any other/unrecognized code) stays "dns_resolution_failed" — a genuine
 *  network/resolver hiccup that retrying later might help. Exported so this mapping is directly unit
 *  testable without depending on a real (inherently non-deterministic) DNS failure. */
export function classifyDnsLookupError(err: unknown): "dns_hostname_not_found" | "dns_resolution_failed" {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  if (code === "ENOTFOUND" || code === "ENODATA") return "dns_hostname_not_found";
  return "dns_resolution_failed";
}

/**
 * Public, boolean-returning wrapper around this module's own private-network/scheme checks — the
 * SAME logic safeFetch itself uses for every hop, exported so a caller that needs boolean
 * semantics instead of a thrown SafeFetchError (e.g. the browser-based Tier-3 discovery fallback's
 * per-navigation request interception, see src/lib/ats/discoveryBrowser.ts) never has to
 * re-implement private-IP/loopback/link-local/DNS-rebinding detection. This is the ONLY sanctioned
 * way for a non-safeFetch code path in this project to validate a URL's safety — see AGENTS.md's
 * "any future discovery-related change must go through safeFetch, never a raw fetch()" precedent,
 * extended here to browser navigation, which safeFetch itself can't cover directly.
 */
export async function isUrlSafeForNavigation(urlString: string, allowPrivateNetworksForTests = false): Promise<boolean> {
  try {
    await assertSafeUrl(urlString, allowPrivateNetworksForTests);
    return true;
  } catch (err) {
    if (err instanceof SafeFetchError) return false;
    throw err;
  }
}

async function assertSafeUrl(urlString: string, allowPrivateNetworksForTests: boolean): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new SafeFetchError("invalid_url", `Not a valid URL: ${urlString}`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SafeFetchError("disallowed_scheme", `Disallowed URL scheme: ${parsed.protocol}`);
  }

  if (allowPrivateNetworksForTests) return parsed;

  const hostname = parsed.hostname.toLowerCase();
  if (DISALLOWED_HOSTNAME_LITERALS.has(hostname)) {
    throw new SafeFetchError("disallowed_host", `Disallowed host: ${hostname}`);
  }

  // Literal IP in the URL (v4 or bracketed v6) — check directly, no DNS involved.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isDisallowedIPv4(hostname)) throw new SafeFetchError("disallowed_host", `Disallowed IP literal: ${hostname}`);
    return parsed;
  }
  if (hostname.includes(":")) {
    if (isDisallowedIPv6(hostname)) throw new SafeFetchError("disallowed_host", `Disallowed IP literal: ${hostname}`);
    return parsed;
  }

  // Hostname — resolve and validate every returned address, so a DNS-rebinding hostname (or one
  // with a mix of public/private A records) is rejected exactly as much as a literal private IP.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SafeFetchError(classifyDnsLookupError(err), `Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) {
    // A lookup that succeeded but returned zero addresses is the same authoritative "no such host"
    // outcome as ENOTFOUND, just surfaced without an exception — same hard classification applies.
    throw new SafeFetchError("dns_hostname_not_found", `No addresses resolved for host: ${hostname}`);
  }
  for (const { address, family } of addresses) {
    if (isDisallowedIp(address, family === 6 ? 6 : 4)) {
      throw new SafeFetchError("disallowed_host", `Host ${hostname} resolves to a disallowed address: ${address}`);
    }
  }

  return parsed;
}

async function readBodyWithCap(res: Response, maxResponseBytes: number): Promise<string> {
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > maxResponseBytes) {
    throw new SafeFetchError("response_too_large", `Content-Length ${contentLengthHeader} exceeds ${maxResponseBytes} bytes`);
  }

  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxResponseBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError("response_too_large", `Response exceeded ${maxResponseBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 CareerOpsDiscoveryBot";

/**
 * Fetches `url`, following up to `maxRedirects` redirects (each hop revalidated), enforcing an
 * overall `timeoutMs` wall-clock budget and a `maxResponseBytes` body cap. Throws SafeFetchError for
 * every rejected/failed case — callers (discovery.ts) are expected to catch this and record a
 * diagnostic reason, never to let a raw network exception propagate.
 */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const allowPrivateNetworksForTests = options.allowPrivateNetworksForTests ?? false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let current = await assertSafeUrl(url, allowPrivateNetworksForTests);
    const visited = new Set<string>();
    let redirectCount = 0;

    for (;;) {
      visited.add(current.toString());

      let res: Response;
      try {
        res = await fetch(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "text/html", ...options.headers },
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new SafeFetchError("timeout", `Request timed out after ${timeoutMs}ms`);
        }
        throw new SafeFetchError("network_error", err instanceof Error ? err.message : String(err));
      }

      if (res.status >= 300 && res.status < 400) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new SafeFetchError("too_many_redirects", `Exceeded ${maxRedirects} redirects`);
        }
        const location = res.headers.get("location");
        if (!location) {
          throw new SafeFetchError("missing_redirect_location", `Redirect status ${res.status} had no Location header`);
        }
        const nextUrl = new URL(location, current);
        if (visited.has(nextUrl.toString())) {
          throw new SafeFetchError("redirect_loop", `Redirect loop detected at ${nextUrl.toString()}`);
        }
        // Revalidate the redirect destination exactly like the original URL — this is the whole
        // point: a same-origin-looking redirect chain can still terminate at a private/loopback host.
        current = await assertSafeUrl(nextUrl.toString(), allowPrivateNetworksForTests);
        continue;
      }

      let bodyText: string;
      try {
        bodyText = await readBodyWithCap(res, maxResponseBytes);
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new SafeFetchError("timeout", `Request timed out after ${timeoutMs}ms`);
        }
        throw new SafeFetchError("network_error", err instanceof Error ? err.message : String(err));
      }
      return { status: res.status, finalUrl: current.toString(), headers: res.headers, bodyText };
    }
  } finally {
    clearTimeout(timeout);
  }
}
