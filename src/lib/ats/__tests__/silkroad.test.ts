import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { canonicalSilkRoadUrl, fetchSilkRoadJobs, normalizeSilkRoadToken } from "@/lib/ats/silkroad";

test("SilkRoad identity is an exact account/site pair", () => { assert.equal(normalizeSilkRoadToken("TraylorBros|TraylorCareers"), "TraylorBros|TraylorCareers"); assert.equal(canonicalSilkRoadUrl("TraylorBros|TraylorCareers"), "https://jobs.silkroad.com/TraylorBros/TraylorCareers"); });

test("SilkRoad exhausts exact pages and filters before details", async () => {
  const requested: string[] = []; let origin = ""; const root = "/TraylorBros/TraylorCareers";
  const page = (n:number,total:number,id:string,title:string,location:string) => `<h1 id="Jobs_JobsList_CompanyName">Example</h1><h2 id="Jobs_PagedJobList_Category__1">Engineering</h2><a id="Jobs_PagedJobList_Job-${id}" href="${root}/jobs/${id}"><div id="Jobs_PagedJobList_JobTitle-${id}">${title}</div><div id="Jobs_PagedJobList_JobLocation-${id}"><span>${location}</span></div></a><div id="Jobs_PagedJobList_CurrentPageText">Page ${n} of ${total}</div>`;
  const server=http.createServer((req,res)=>{res.setHeader("Content-Type","text/html");if(req.url===root)return res.end(page(1,2,"101","US Engineer","Austin, Texas, United States"));if(req.url===`${root}?page=2`)return res.end(page(2,2,"202","EU Engineer","Berlin, Germany"));const id=req.url?.match(/\/jobs\/(\d+)/)?.[1];if(id){requested.push(id);return res.end(`<meta property="og:url" content="${origin}${root}/jobs/${id}"><h1 id="Jobs_JobDetail_TitleText">US Engineer</h1><div id="Jobs_JobDetail_LocationText">Austin, TX</div><div id="Jobs_JobDetail_JobPositionTypeText">Full-Time</div><div id="Jobs_JobDetail_JobDescriptionText"><p>Complete U.S. description.</p></div></section><a href="${root}/Apply/MultiForm/${id}">Apply</a>`)}res.statusCode=404;res.end()});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));try{const a=server.address();const p=typeof a==="object"&&a?a.port:0;origin=`http://127.0.0.1:${p}`;const jobs=await fetchSilkRoadJobs("TraylorBros|TraylorCareers",{originOverride:origin,usOnly:true,maxJobs:3,maxAttempts:1});assert.deepEqual(requested,["101"]);assert.deepEqual(jobs.map(j=>j.externalId),["101"])}finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
