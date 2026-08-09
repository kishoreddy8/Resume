import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  clearWikidataLookupCache,
  disambiguateEntities,
  extractP31AndWebsite,
  filterExactSearchMatches,
  lookupWikidataEntity,
  type WikidataEntity,
} from "@/lib/companyIdentity/wikidataLookup";

test("filterExactSearchMatches keeps only exact label/alias matches, discards fuzzy/description matches", () => {
  const results = [
    { id: "Q1", display: { label: { value: "Microsoft" } }, match: { type: "alias", text: "Microsoft Corporation" } },
    { id: "Q2", display: { label: { value: "Microsoft Knowledge Base" } }, match: { type: "description", text: "about Microsoft Corporation products" } },
    { id: "Q3", display: { label: { value: "Something Else" } }, match: { type: "label", text: "microsoft corp" } }, // not exact
  ];
  const kept = filterExactSearchMatches(results, "microsoft corporation");
  assert.deepEqual(kept, [{ qid: "Q1", label: "Microsoft" }]);
});

test("filterExactSearchMatches dedupes by QID", () => {
  const results = [
    { id: "Q1", display: { label: { value: "Acme" } }, match: { type: "label", text: "Acme" } },
    { id: "Q1", display: { label: { value: "Acme" } }, match: { type: "alias", text: "Acme" } },
  ];
  const kept = filterExactSearchMatches(results, "acme");
  assert.equal(kept.length, 1);
});

test("extractP31AndWebsite reads instance-of QIDs and the first P856 website, defensively", () => {
  const entity = {
    claims: {
      P31: [{ mainsnak: { datavalue: { value: { id: "Q4830453" } } } }],
      P856: [{ mainsnak: { datavalue: { value: "https://acme.com" } } }],
    },
  };
  const { p31, website } = extractP31AndWebsite(entity);
  assert.deepEqual(p31, ["Q4830453"]);
  assert.equal(website, "https://acme.com");
});

test("extractP31AndWebsite handles a missing claims block without throwing", () => {
  const { p31, website } = extractP31AndWebsite({});
  assert.deepEqual(p31, []);
  assert.equal(website, null);
});

test("disambiguateEntities: zero entities -> no_match", () => {
  assert.equal(disambiguateEntities([]).status, "no_match");
});

test("disambiguateEntities: single entity with a website -> single_match with that domain", () => {
  const entities: WikidataEntity[] = [{ qid: "Q2283", label: "Microsoft", website: "https://www.microsoft.com/en-us" }];
  const result = disambiguateEntities(entities);
  assert.equal(result.status, "single_match");
  assert.equal(result.domain, "microsoft.com");
});

test("disambiguateEntities: entities found but none has a website -> no_match, not ambiguous", () => {
  const entities: WikidataEntity[] = [{ qid: "Q1", label: "Foo", website: null }, { qid: "Q2", label: "Foo", website: null }];
  assert.equal(disambiguateEntities(entities).status, "no_match");
});

test("disambiguateEntities: two entities with DIFFERING websites -> ambiguous, never a guess", () => {
  const entities: WikidataEntity[] = [
    { qid: "Q1", label: "Acme", website: "https://acme-holdings.com" },
    { qid: "Q2", label: "Acme", website: "https://acme-unrelated.com" },
  ];
  const result = disambiguateEntities(entities);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.domain, null);
});

test("disambiguateEntities: multiple entities that all agree on the SAME website -> single_match, not ambiguous", () => {
  const entities: WikidataEntity[] = [
    { qid: "Q1", label: "Acme", website: "https://acme.com" },
    { qid: "Q2", label: "Acme Inc", website: "https://acme.com" },
  ];
  const result = disambiguateEntities(entities);
  assert.equal(result.status, "single_match");
  assert.equal(result.domain, "acme.com");
});

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/w/api.php`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/** Mimics the real MediaWiki API: one endpoint, dispatched by the `action` query param —
 *  wbsearchentities then wbgetentities, exactly the two calls lookupWikidataEntity makes. */
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

test("lookupWikidataEntity: full round trip (search -> filter -> batched claims -> disambiguate), and caches", async () => {
  clearWikidataLookupCache();
  let requestCount = 0;
  const search = {
    search: [{ id: "Q2283", display: { label: { value: "Microsoft" } }, match: { type: "alias", text: "Microsoft Corporation" } }],
  };
  const entities = {
    entities: {
      Q2283: {
        claims: {
          P31: [{ mainsnak: { datavalue: { value: { id: "Q4830453" } } } }],
          P856: [{ mainsnak: { datavalue: { value: "https://www.microsoft.com/" } } }],
        },
      },
    },
  };
  const baseHandler = wikidataApiHandler(search, entities);
  const { url, close } = await startServer((req, res) => {
    requestCount++;
    baseHandler(req, res);
  });
  try {
    const first = await lookupWikidataEntity("Microsoft Corporation", { endpointOverride: url });
    assert.equal(first.status, "single_match");
    assert.equal(first.domain, "microsoft.com");
    assert.equal(requestCount, 2, "one wbsearchentities call + one wbgetentities call");

    await lookupWikidataEntity("Microsoft Corporation", { endpointOverride: url });
    assert.equal(requestCount, 2, "repeated lookup for the same employer must be served from cache");
  } finally {
    await close();
  }
});

test("lookupWikidataEntity: a candidate whose P31 is not organization-shaped is excluded (e.g. a legal case, not a company)", async () => {
  clearWikidataLookupCache();
  const search = {
    search: [{ id: "Q22906897", display: { label: { value: "Microsoft Corp. v. United States" } }, match: { type: "alias", text: "Some Company" } }],
  };
  const entities = {
    entities: {
      Q22906897: { claims: { P31: [{ mainsnak: { datavalue: { value: { id: "Q16514610" } } } }] } }, // "legal case", not organization-shaped
    },
  };
  const { url, close } = await startServer(wikidataApiHandler(search, entities));
  try {
    const result = await lookupWikidataEntity("Some Company", { endpointOverride: url });
    assert.equal(result.status, "no_match");
  } finally {
    await close();
  }
});

test("lookupWikidataEntity: no exact search matches -> no_match without a second (wbgetentities) call", async () => {
  clearWikidataLookupCache();
  let getEntitiesCalled = false;
  const { url, close } = await startServer((req, res) => {
    const action = new URL(req.url ?? "", "http://localhost").searchParams.get("action");
    if (action === "wbgetentities") getEntitiesCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ search: [] }));
  });
  try {
    const result = await lookupWikidataEntity("Totally Unknown Employer", { endpointOverride: url });
    assert.equal(result.status, "no_match");
    assert.equal(getEntitiesCalled, false, "no candidates means no second call is needed");
  } finally {
    await close();
  }
});

test("lookupWikidataEntity: a request failure resolves to status 'error', never throws", async () => {
  clearWikidataLookupCache();
  const { url, close } = await startServer((req, res) => {
    res.writeHead(500);
    res.end("server error");
  });
  try {
    const result = await lookupWikidataEntity("Some Company That Will Fail", { endpointOverride: url });
    assert.equal(result.status, "error");
    assert.equal(result.domain, null);
  } finally {
    await close();
  }
});
