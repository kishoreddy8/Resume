import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { clearSecTickersCache, findSecCorroboration } from "@/lib/companyIdentity/secLookup";

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/company_tickers.json`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

test("findSecCorroboration: a real registered filer's exact normalized name matches", async () => {
  clearSecTickersCache();
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        "0": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
        "1": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
      })
    );
  });
  try {
    const result = await findSecCorroboration("Microsoft Corporation", { urlOverride: url });
    assert.equal(result.matched, true);
    assert.equal(result.ticker, "MSFT");
    assert.equal(result.cik, "789019");
  } finally {
    await close();
  }
});

test("findSecCorroboration: a private company with no SEC record -> not matched, never throws", async () => {
  clearSecTickersCache();
  const { url, close } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ "0": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" } }));
  });
  try {
    const result = await findSecCorroboration("Some Private Staffing Firm LLC", { urlOverride: url });
    assert.equal(result.matched, false);
  } finally {
    await close();
  }
});

test("findSecCorroboration: the ticker list is fetched once and cached across calls", async () => {
  clearSecTickersCache();
  let requestCount = 0;
  const { url, close } = await startServer((req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ "0": { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" } }));
  });
  try {
    await findSecCorroboration("Microsoft Corporation", { urlOverride: url });
    await findSecCorroboration("Apple Inc", { urlOverride: url });
    assert.equal(requestCount, 1, "the whole ticker list is fetched once, not once per employer");
  } finally {
    await close();
  }
});

test("findSecCorroboration: a request failure resolves to not-matched, never throws", async () => {
  clearSecTickersCache();
  const { url, close } = await startServer((req, res) => {
    res.writeHead(500);
    res.end("error");
  });
  try {
    const result = await findSecCorroboration("Anything", { urlOverride: url });
    assert.equal(result.matched, false);
  } finally {
    await close();
  }
});
