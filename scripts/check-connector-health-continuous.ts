import fs from "node:fs";
import path from "node:path";
import { runConnectorHealthBatch } from "../src/lib/ats/connectorHealthCheck";

const DATA_DIR = path.resolve("data");
const LOCK_PATH = path.join(DATA_DIR, "connector-health-worker.lock");
const REPORT_DIR = path.join(DATA_DIR, "connector-health-reports");
const BATCH_PAUSE_MS = 5 * 60_000;
const IDLE_PAUSE_MS = 15 * 60_000;

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function acquireLock(): boolean {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" }); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try { const lock=JSON.parse(fs.readFileSync(LOCK_PATH,"utf8")) as {pid?:number}; if (lock.pid && pidIsAlive(lock.pid)) return false; } catch { /* stale */ }
    fs.unlinkSync(LOCK_PATH);
    fs.writeFileSync(LOCK_PATH, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return true;
  }
}
function releaseLock(): void { try { const lock=JSON.parse(fs.readFileSync(LOCK_PATH,"utf8")) as {pid?:number}; if(lock.pid===process.pid) fs.unlinkSync(LOCK_PATH); } catch { /* no-op */ } }
function writeReport(summary: Awaited<ReturnType<typeof runConnectorHealthBatch>>): void {
  fs.mkdirSync(REPORT_DIR,{recursive:true});
  fs.appendFileSync(path.join(REPORT_DIR,"batches.jsonl"),`${JSON.stringify(summary)}\n`);
  const temp=path.join(REPORT_DIR,`latest.${process.pid}.tmp`);
  fs.writeFileSync(temp,`${JSON.stringify(summary,null,2)}\n`);
  fs.renameSync(temp,path.join(REPORT_DIR,"latest.json"));
}
const sleep=(ms:number)=>new Promise((resolve)=>setTimeout(resolve,ms));

async function main(): Promise<void> {
  if(!acquireLock()){ console.log("Another connector-health worker owns the lock; exiting."); return; }
  process.on("exit",releaseLock); process.on("SIGINT",()=>process.exit(0)); process.on("SIGTERM",()=>process.exit(0));
  let failurePause=5*60_000;
  while(true){
    try {
      const summary=await runConnectorHealthBatch({batchSize:10,concurrency:2,intervalHours:24});
      if(summary.attempted===0){ await sleep(IDLE_PAUSE_MS); continue; }
      writeReport(summary);
      console.log(`Health batch: ${summary.attempted} checked, ${summary.healthyJobs} jobs, ${summary.healthyEmpty} empty, ${summary.failedTemporary} temporary, ${summary.failedHard} hard.`);
      failurePause=5*60_000; await sleep(BATCH_PAUSE_MS);
    } catch(error){ console.error(`Health batch failed: ${error instanceof Error?error.message:String(error)}`); await sleep(failurePause); failurePause=Math.min(60*60_000,failurePause*2); }
  }
}
main().catch((error)=>{ console.error("Continuous connector health worker failed:",error); process.exit(1); });
