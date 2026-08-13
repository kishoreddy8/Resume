import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalCatsUrl, fetchCatsJobs, normalizeCatsToken } from "@/lib/ats/cats";

test("CATS identity is exact host and numeric portal", () => {
  assert.equal(normalizeCatsToken("Example.CatsOne.com|736"), "example.catsone.com|736");
  assert.equal(canonicalCatsUrl("example.catsone.com|736"), "https://example.catsone.com/careers/736");
  assert.throws(() => normalizeCatsToken("example.catsone.com"));
});

test("CATS filters the complete listing before exact portal details", async () => {
  const requested: string[] = []; let origin = "";
  const row = (id:string,title:string,location:string) => `<a class="table-row" href="/careers/736/jobs/${id}-${title.toLowerCase().replaceAll(" ","-")}"><div class="data-cell title-cell">${title}</div><div class="data-cell" data-label="Category">Engineering</div><div class="data-cell" data-label="Location">${location}</div></a>`;
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type","text/html"); if(req.url==="/careers/736") return res.end(`<a href="/careers/736/register">Register</a><div class="jobs-table">${row("123","US Engineer","Remote, US")}${row("456","EU Engineer","Berlin, Germany")}</div><footer>Powered by <a href="https://catsone.com">CATS</a></footer>`); const m=req.url?.match(/^\/careers\/736\/jobs\/(\d+)-/); if(m){requested.push(m[1]); const path=req.url!; return res.end(`<meta property="og:url" content="${origin}${path}"><div class="job-header"><h1>US Engineer</h1></div><div><div><div class="job-description"><p>Complete U.S. role. Salary $120,000.</p></div></div></div><aside><a href="${path}/apply">Apply Now</a></aside>`)} res.statusCode=404;res.end()});
  await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));
  try{const address=server.address();const port=typeof address==="object"&&address?address.port:0;origin=`http://127.0.0.1:${port}`;const jobs=await fetchCatsJobs("example.catsone.com|736",{hostOverride:origin,usOnly:true,maxJobs:3,maxAttempts:1});assert.deepEqual(requested,["123"]);assert.deepEqual(jobs.map(j=>j.externalId),["123"]);assert.match(jobs[0].descriptionText??"",/Complete U.S. role/)}finally{await new Promise<void>((resolve)=>server.close(()=>resolve()))}
});
