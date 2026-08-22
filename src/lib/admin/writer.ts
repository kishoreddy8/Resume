import { getDb } from "@/db";
import { getResumeWriterHealth } from "@/lib/resumeQuality/writers/writerHealth";
import { getLoadedResumeWriterRuntimeContract } from "@/lib/resumeQuality/runtimeContract";
import { readBackgroundWorkerStatus } from "@/lib/scheduler/workerStatus";
import { compareRuntimeVersions } from "./overview";

export function listAdminWriterWorkflows(input:{page:number;limit:number;status:string}){
  const where=input.status?"WHERE w.status = @status":"";const params=input.status?{status:input.status}:{};const offset=(input.page-1)*input.limit;
  const total=(getDb().prepare(`SELECT COUNT(*) AS count FROM resume_quality_workflows w ${where}`).get(params) as {count:number}).count;
  const workflows=getDb().prepare(
    `SELECT w.id, c.display_name AS candidate, j.title AS jobTitle, co.name AS company,
            w.status, w.current_iteration AS iteration, w.max_iterations AS maxIterations,
            w.latest_overall_score AS lastScore, w.writer_provider AS provider, w.writer_model AS model,
            w.failure_reason AS blocker, w.created_at AS createdAt, w.updated_at AS updatedAt
     FROM resume_quality_workflows w JOIN candidates c ON c.id=w.candidate_id
     LEFT JOIN jobs j ON j.dedupe_key=w.dedupe_key LEFT JOIN companies co ON co.id=j.company_id
     ${where} GROUP BY w.id ORDER BY w.updated_at DESC,w.id DESC LIMIT @limit OFFSET @offset`
  ).all({...params,limit:input.limit,offset});
  const health=getResumeWriterHealth();const worker=readBackgroundWorkerStatus();const web=getLoadedResumeWriterRuntimeContract();
  return {generatedAt:new Date().toISOString(),health,worker,runtime:{web,compatibility:compareRuntimeVersions(web,worker)},workflows,page:input.page,total,totalPages:Math.max(1,Math.ceil(total/input.limit))};
}
