import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { clearWikidataLookupCache } from "@/lib/companyIdentity/wikidataLookup";
import { clearSecTickersCache } from "@/lib/companyIdentity/secLookup";
import { normalizeEmployerName } from "@/lib/h1b/normalizeEmployerName";

let tmpDir: string;
let resolveDomainIdentity: typeof import("../resolveDomain").resolveDomainIdentity;
let addDomainOverride: typeof import("../../../db/queries/h1bEmployerDomainOverrides").addDomainOverride;

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

function html(body: string): string {
  return `<html><body>${body}</body></html>`;
}

function emptyTickers() {
  return JSON.stringify({});
}

/** Mimics the real MediaWiki API dispatch-by-action shape lookupWikidataEntity actually calls
 *  (wbsearchentities then wbgetentities) — see wikidataLookup.test.ts's identical helper. */
function wikidataApiHandler(search: object, entities: object): http.RequestListener {
  return (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const action = url.searchParams.get("action");
    res.writeHead(200, { "Content-Type": "application/json" });
    if (action === "wbsearchentities") res.end(JSON.stringify(search));
    else if (action === "wbgetentities") res.end(JSON.stringify(entities));
    else res.end(JSON.stringify({}));
  };
}

function emptyWikidataSearch() {
  return { search: [] };
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-resolve-domain-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ resolveDomainIdentity } = await import("../resolveDomain"));
  ({ addDomainOverride } = await import("../../../db/queries/h1bEmployerDomainOverrides"));
  const { getDb } = await import("../../../db/index");
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("LAYER 0: a curated override resolves VERIFIED instantly, with no live network call at all", async () => {
  // Curation must be keyed on the SAME normalized identity resolveDomainIdentity itself computes
  // (normalizeEmployerName) — "Curated Holdings" strips its trailing suffix word just like any
  // other employer name, so the override has to be stored under that normalized form, not the raw
  // display name, exactly as a real curation admin flow would compute it.
  const employerName = "Curated Holdings";
  addDomainOverride({ employerNameNormalized: normalizeEmployerName(employerName), domain: "curatedco.com" });
  const result = await resolveDomainIdentity(employerName);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.domain, "curatedco.com");
  assert.equal(result.method, "curated");
});

test("LAYER 1: a confidently-disambiguated Wikidata hit that verifies -> VERIFIED via wikidata, Layer 2 never attempted", async () => {
  clearWikidataLookupCache();
  clearSecTickersCache();
  // resolveDomainIdentity queries Wikidata with the NORMALIZED name (normalizeEmployerName strips
  // "Corporation" as a trailing suffix word) — so the mock's match.text must equal "Wikico", the
  // stripped form, not the raw "Wikico Corporation" input, mirroring what Wikidata's real label
  // for a company is actually shaped like (e.g. "Microsoft", not "Microsoft Corporation").
  const wikidata = await startServer(
    wikidataApiHandler(
      { search: [{ id: "Q999", display: { label: { value: "Wikico" } }, match: { type: "label", text: "Wikico" } }] },
      { entities: { Q999: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q4830453" } } } }], P856: [{ mainsnak: { datavalue: { value: "http://placeholder/" } } }] } } } }
    )
  );
  const target = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html("plain homepage"));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await resolveDomainIdentity("Wikico Corporation", {
      wikidataEndpointOverride: `${wikidata.url}`,
      verifyRootUrlOverride: `${target.url}/`,
      allowPrivateNetworksForTests: true,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.method, "wikidata");
  } finally {
    await wikidata.close();
    await target.close();
  }
});

test("LAYER 1 ambiguous falls through to LAYER 2, which independently resolves via Path B", async () => {
  clearWikidataLookupCache();
  clearSecTickersCache();
  // "Beta Technologies" normalizes to "BETA" (TECHNOLOGIES is a stripped suffix word) — two
  // distinct organization entities both exactly matching "Beta" with DIFFERING websites.
  const wikidata = await startServer(
    wikidataApiHandler(
      {
        search: [
          { id: "Q1", display: { label: { value: "Beta" } }, match: { type: "label", text: "Beta" } },
          { id: "Q2", display: { label: { value: "Beta" } }, match: { type: "label", text: "Beta" } },
        ],
      },
      {
        entities: {
          Q1: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q4830453" } } } }], P856: [{ mainsnak: { datavalue: { value: "https://beta-one.example" } } }] } },
          Q2: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q4830453" } } } }], P856: [{ mainsnak: { datavalue: { value: "https://beta-two.example" } } }] } },
        },
      }
    )
  );
  const sec = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(emptyTickers());
  });
  const target = await startServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        html(
          `<script type="application/ld+json">{"@type":"Organization","legalName":"Beta Technologies"}</script>` +
            `<footer>© 2026 Beta Technologies. All rights reserved</footer>`
        )
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const result = await resolveDomainIdentity("Beta Technologies", {
      wikidataEndpointOverride: `${wikidata.url}`,
      secUrlOverride: `${sec.url}/company_tickers.json`,
      verifyRootUrlOverride: `${target.url}/`,
      allowPrivateNetworksForTests: true,
    });
    assert.equal(result.status, "VERIFIED");
    assert.equal(result.method, "generated_verified_multisignal");
  } finally {
    await wikidata.close();
    await sec.close();
    await target.close();
  }
});

test("nothing resolves anywhere -> honest UNRESOLVED, never a guess", async () => {
  clearWikidataLookupCache();
  clearSecTickersCache();
  const wikidata = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(emptyWikidataSearch()));
  });
  const sec = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(emptyTickers());
  });
  const target = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html("nothing useful here"));
  });
  try {
    const result = await resolveDomainIdentity("Totally Unknown Employer LLC", {
      wikidataEndpointOverride: `${wikidata.url}`,
      secUrlOverride: `${sec.url}/company_tickers.json`,
      verifyRootUrlOverride: `${target.url}/`,
      allowPrivateNetworksForTests: true,
    });
    assert.equal(result.status, "UNRESOLVED");
    assert.equal(result.domain, null);
  } finally {
    await wikidata.close();
    await sec.close();
    await target.close();
  }
});
