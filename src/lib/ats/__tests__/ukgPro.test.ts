import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  canonicalUkgProUrl,
  decodeUkgProToken,
  encodeUkgProToken,
  extractUkgAssignedObject,
  fetchUkgProJobs,
} from "@/lib/ats/ukgPro";

const identity = {
  host: "recruiting2.ultipro.com" as const,
  tenant: "EXA1000",
  boardId: "f54234e9-dfde-b183-fd20-4fbdb19cba7a",
};

const usOne = "11111111-1111-4111-8111-111111111111";
const nonUs = "22222222-2222-4222-8222-222222222222";
const usTwo = "33333333-3333-4333-8333-333333333333";

function opportunity(id: string, title: string, countryCode: string, countryName: string) {
  return {
    Id: id,
    Title: title,
    RequisitionNumber: `REQ-${id.slice(0, 4)}`,
    FullTime: true,
    JobCategoryName: "Engineering",
    Locations: [{ Address: { City: countryCode === "USA" ? "Austin" : "Toronto", State: { Code: countryCode === "USA" ? "TX" : "ON" }, Country: { Code: countryCode, Name: countryName } } }],
    PostedDate: "2026-08-01T00:00:00Z",
    BriefDescription: "Listing description",
  };
}

test("UKG Pro identity round-trips and canonicalizes its exact board", () => {
  const token = encodeUkgProToken(identity);
  assert.deepEqual(decodeUkgProToken(token), identity);
  assert.equal(canonicalUkgProUrl(token),
    "https://recruiting2.ultipro.com/EXA1000/JobBoard/f54234e9-dfde-b183-fd20-4fbdb19cba7a/");
  assert.throws(() => decodeUkgProToken("recruiting2.ultipro.com|EXA1000|not-a-uuid"));
});

test("UKG assigned-object parser handles braces and escaped text", () => {
  const parsed = extractUkgAssignedObject<{ Description: string }>(
    'var opportunity = new US.Opportunity.CandidateOpportunityDetail({"Description":"Use {data} and \\"quotes\\""});',
    "var opportunity = new US.Opportunity.CandidateOpportunityDetail("
  );
  assert.equal(parsed.Description, 'Use {data} and "quotes"');
});

test("UKG preserves its public session, exhausts totalCount pages, and filters before details", async () => {
  const skips: number[] = [];
  const detailIds: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/JobBoard/f54234e9-dfde-b183-fd20-4fbdb19cba7a/")) {
      res.setHeader("Set-Cookie", "ukg-session=fixture; Path=/; HttpOnly");
      res.end("<html>Public board</html>");
      return;
    }
    assert.match(req.headers.cookie ?? "", /ukg-session=fixture/);
    if (req.url?.endsWith("/JobBoardView/LoadSearchResults")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body) as { opportunitySearch: { Skip: number; Top: number } };
      skips.push(payload.opportunitySearch.Skip);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload.opportunitySearch.Skip === 0
        ? { opportunities: [opportunity(usOne, "US Engineer", "USA", "United States"), opportunity(nonUs, "Canada Engineer", "CAN", "Canada")], totalCount: 51 }
        : { opportunities: [opportunity(usTwo, "US Data Engineer", "USA", "United States")], totalCount: 51 }));
      return;
    }
    const id = new URL(req.url ?? "/", "http://fixture").searchParams.get("opportunityId");
    if (id) {
      detailIds.push(id);
      const detail = {
        ...opportunity(id, id === usOne ? "US Engineer" : "US Data Engineer", "USA", "United States"),
        Description: `<h2>Overview</h2><p>Complete UKG description ${id}. Salary $120,000 - $140,000 per year.</p>`,
        CompensationAnnualMinimum: 120000,
        CompensationAnnualMaximum: 140000,
        CompensationCurrency: "USD",
        Salaried: true,
      };
      res.end(`<script>var opportunity = new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify(detail)});</script>`);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const jobs = await fetchUkgProJobs(encodeUkgProToken(identity), {
      hostOverride: `http://127.0.0.1:${port}`,
      usOnly: true,
      maxJobs: 3,
      maxAttempts: 1,
    });
    assert.deepEqual(skips, [0, 50]);
    assert.deepEqual(detailIds.sort(), [usOne, usTwo].sort());
    assert.deepEqual(jobs.map((job) => job.externalId), [usOne, usTwo]);
    assert.equal(jobs[0].descriptionText?.includes("Complete UKG description"), true);
    assert.equal(jobs[0].salaryText, "$120,000 - $140,000");
    assert.equal(jobs[0].location, "Austin, TX, USA");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
