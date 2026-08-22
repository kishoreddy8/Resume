import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCompanySource } from "@/lib/ats/discovery";
import {
  detectUnsupportedAtsUrl,
  isKnownVendorAssetFalsePositive,
  UNSUPPORTED_ATS_SIGNATURES,
} from "@/lib/ats/unsupportedCatalog";

const EXAMPLES: [string, string][] = [
  ["https://jobs.dayforcehcm.com/en-US/example/jobs", "Dayforce"],
  ["https://example.phenompeople.com/us/en/search-results", "Phenom"],
  ["https://example.avature.net/careers", "Avature"],
  ["https://example.jobs.personio.com/", "Personio"],
  ["https://careers.zohorecruit.com/jobs/Careers", "Zoho Recruit"],
  ["https://example.fountain.com/jobs", "Fountain"],
  ["https://example.peoplefluent.com/res_joblist", "PeopleFluent"],
  ["https://example.bullhornstaffing.com/JobBoard/", "Bullhorn"],
  ["https://www.hirebridge.com/jobseeker2/jobs", "Hirebridge"],
  ["https://jobs.ourcareerpages.com/example", "isolved Talent Acquisition"],
  ["https://apply.eddy.com/example", "Eddy"],
  ["https://example.homerun.co/jobs", "Homerun"],
  ["https://careers.manatal.com/example", "Manatal"],
  ["https://hire.trakstar.com/jobs/example", "Trakstar Hire"],
  ["https://apply.workstream.us/j/example", "Workstream"],
];

test("unsupported ATS catalog recognizes every registered provider example", () => {
  assert.ok(UNSUPPORTED_ATS_SIGNATURES.length >= EXAMPLES.length);
  for (const [url, expected] of EXAMPLES) assert.equal(detectUnsupportedAtsUrl(url), expected, url);
});

test("vendor legal and static-asset URLs are not classified as employer ATS boards", () => {
  const falsePositives = [
    "https://www.icims.com/legal/privacy-notice-website/",
    "https://performancemanager4.successfactors.com/verp/vmod_v1/ui/extlib/jquery_3.5.1/jquery.js",
    "https://jobs.jobvite.com/__assets__/scripts/careersite/public/iframe.js",
    "https://performancemanager4.successfactors.com/Dexcom/EmployeePrivacyNotice.pdf",
    "https://cdn.phenompeople.com/CareerConnectResources/example/social/logo.jpg",
    "https://cdn.phenompeople.com/",
    "https://rmkcdn.successfactors.com/example/logo.png",
    "https://workforcenow.adp.com/mascsr/default/mdf/recwebcomponents/recruitment/main-config/recruitment.js",
  ];
  for (const url of falsePositives) {
    assert.equal(detectUnsupportedAtsUrl(url), null, url);
    assert.equal(isKnownVendorAssetFalsePositive(url), true, url);
  }
});

test("a supported Jobvite direct URL resolves to a normalized structured connector", async () => {
  const result = await discoverCompanySource("https://jobs.jobvite.com/example");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "jobvite");
  assert.equal(result.atsBoardToken, "example");
  assert.equal(result.discoveredJobsUrl, "https://jobs.jobvite.com/example/jobs");
});

test("a supported Personio job URL resolves to its tenant feed identity", async () => {
  const result = await discoverCompanySource("https://example.jobs.personio.de/job/12345");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "personio");
  assert.equal(result.atsBoardToken, "example");
  assert.equal(result.discoveredJobsUrl, "https://example.jobs.personio.de/");
});

test("a supported ApplicantStack detail URL resolves to its tenant openings identity", async () => {
  const result = await discoverCompanySource("https://example.applicantstack.com/x/detail/abc123");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "applicantstack");
  assert.equal(result.atsBoardToken, "example");
  assert.equal(result.discoveredJobsUrl, "https://example.applicantstack.com/x/openings");
});

test("a supported Comeet job URL resolves to its exact company board", async () => {
  const result = await discoverCompanySource("https://www.comeet.com/jobs/lumus/62.00F/role/3A.759");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "comeet");
  assert.equal(result.atsBoardToken, "lumus|62.00F");
  assert.equal(result.discoveredJobsUrl, "https://www.comeet.com/jobs/lumus/62.00F");
});

test("a supported CATS registration URL resolves to its numeric portal board", async () => {
  const result = await discoverCompanySource("https://example.catsone.com/careers/736-General/register");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "cats");
  assert.equal(result.atsBoardToken, "example.catsone.com|736");
  assert.equal(result.discoveredJobsUrl, "https://example.catsone.com/careers/736");
});

test("a supported GoHire URL resolves to its exact widget identity", async () => {
  const result = await discoverCompanySource("https://widget.gohire.io/widget/9t3BsLUp");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "gohire");
  assert.equal(result.atsBoardToken, "9t3BsLUp");
  assert.equal(result.discoveredJobsUrl, "https://widget.gohire.io/widget/9t3BsLUp");
});

test("a legacy Newton iframe resolves to its migrated Recruiting by Paycor board", async () => {
  const clientId = "8a78826752b0003a0152d305414414ee";
  const result = await discoverCompanySource(`https://newton.newtonsoftware.com/career/iframe.action?clientId=${clientId}`);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "newton");
  assert.equal(result.atsBoardToken, clientId);
  assert.equal(result.discoveredJobsUrl, `https://recruitingbypaycor.com/career/CareerHome.action?clientId=${clientId}`);
});

test("a supported SilkRoad job URL resolves to its exact account/site board", async () => {
  const result = await discoverCompanySource("https://jobs.silkroad.com/TraylorBros/TraylorCareers/jobs/1809");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "silkroad");
  assert.equal(result.atsBoardToken, "TraylorBros|TraylorCareers");
  assert.equal(result.discoveredJobsUrl, "https://jobs.silkroad.com/TraylorBros/TraylorCareers");
});

test("a supported JobDiva URL resolves to its exact scoped candidate portal", async () => {
  const account = "7ujdnwmz4uu40171n76wb533tedtri07f69d1vu8oho2xtrahg63pe94t3055tt2";
  const result = await discoverCompanySource(`https://www1.jobdiva.com/portal/?a=${account}&amp;compid=0&amp;divisions=5,2#/jobs/32842765`);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "jobdiva");
  assert.equal(result.atsBoardToken, `www1.jobdiva.com|${account}|0|2,5`);
  assert.equal(result.discoveredJobsUrl, `https://www1.jobdiva.com/portal/?a=${account}&compid=0&divisions=2%2C5#/`);
});

test("a supported Taleo login redirect resolves to its exact tenant career section", async () => {
  const target = encodeURIComponent("https://unifirst.taleo.net/careersection/unf_external_simp/jobsearch.ftl?lang=en");
  const result = await discoverCompanySource(`https://unifirst.taleo.net/careersection/iam/accessmanagement/login.jsf?redirectionURI=${target}`);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "taleo");
  assert.equal(result.atsBoardToken, "unifirst.taleo.net|unf_external_simp");
  assert.equal(result.discoveredJobsUrl, "https://unifirst.taleo.net/careersection/unf_external_simp/jobsearch.ftl?lang=en");
});

test("a resolved ADP MyJobs URL preserves exact tenant configuration identity", async () => {
  const url = "https://myjobs.adp.com/woodmark?siteId=8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee&orgoid=G38EETAC9W8ZZ87W&clientId=woodmark1";
  const result = await discoverCompanySource(url);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "adp_rm");
  assert.equal(result.atsBoardToken, "woodmark|8a85520f-3ae2-4ffc-bdcc-ed9627cf28ee|G38EETAC9W8ZZ87W|woodmark1");
});

test("a resolved Eightfold URL preserves exact host/domain identity", async () => {
  const result = await discoverCompanySource("https://albemarle.eightfold.ai/careers?domain=albemarle.com");
  assert.equal(result.status, "VERIFIED"); assert.equal(result.sourceType, "eightfold");
  assert.equal(result.atsBoardToken, "albemarle.eightfold.ai|albemarle.com");
});

test("a resolved Cornerstone URL preserves exact host/site/corp identity", async () => {
  const result = await discoverCompanySource("https://colorcon.csod.com/ux/ats/careersite/4/home?c=colorcon");
  assert.equal(result.status, "VERIFIED"); assert.equal(result.sourceType, "cornerstone");
  assert.equal(result.atsBoardToken, "colorcon.csod.com|4|colorcon");
});

test("resolved Avature job boards preserve explicit portal modes", async () => {
  const modern = await discoverCompanySource("https://maximus.avature.net/careers/Job-Search_US?listFilterMode=true");
  assert.equal(modern.status, "VERIFIED"); assert.equal(modern.sourceType, "avature");
  assert.equal(modern.atsBoardToken, "maximus.avature.net|template|careers|Job-Search_US");
  const legacy = await discoverCompanySource("https://xerox.avature.net/en_US/careers");
  assert.equal(legacy.status, "VERIFIED"); assert.equal(legacy.sourceType, "avature");
  assert.equal(legacy.atsBoardToken, "xerox.avature.net|legacy|en_US/careers|SearchJobs");
});

test("resolved SuccessFactors job board preserves exact host/company identity", async () => {
  const result = await discoverCompanySource("https://career4.successfactors.com/career?company=Popularinc");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.sourceType, "successfactors");
  assert.equal(result.atsBoardToken, "career4.successfactors.com|Popularinc");
  assert.equal(result.discoveredJobsUrl, "https://career4.successfactors.com/career?company=Popularinc");
});
