import { db } from '@/lib/db';
import type { Run } from '@/domain/v2/types';
import type { EndingAnalysisSnapshot } from '@/domain/worldline/ending';
import { ServiceError } from '../store';
import { type Context, indexRun } from './access';
import { analysisSignature, calculateEnding } from './ending-calculation';
function validate(run:Run,c:Context) {
  if(run.sessionId !== `integrated:${c.workspaceId}:${c.sessionId}`) throw new ServiceError(404,'游戏不存在');
  if(run.status !== 'ended' || run.setup.input.custom) throw new ServiceError(422,'请先结束买车或买房游戏');
}
export async function readEnding(run:Run,c:Context) {
  validate(run,c);
  const row=await db.simulationReport.findFirst({where:{runId:run.id,...c}});
  const analysis=row?.worldlineAnalysisJson ? JSON.parse(row.worldlineAnalysisJson) as EndingAnalysisSnapshot : null;
  return {analysis:analysis?.signature === analysisSignature(run) ? analysis : null};
}
export async function generateEnding(run:Run,c:Context,expectedVersion:number) {
  validate(run,c);
  if(run.version!==expectedVersion) throw new ServiceError(409,'游戏版本已变化，请刷新');
  const cached=await readEnding(run,c); if(cached.analysis) return cached;
  const analysis=calculateEnding(run);
  await indexRun(run,c);
  // Compare-and-set: simultaneous requests retain the first complete snapshot.
  const row=await db.simulationReport.findFirstOrThrow({where:{runId:run.id,...c}});
  if(row.worldlineAnalysisJson && (JSON.parse(row.worldlineAnalysisJson) as EndingAnalysisSnapshot).signature === analysis.signature) return {analysis:JSON.parse(row.worldlineAnalysisJson) as EndingAnalysisSnapshot};
  await db.simulationReport.updateMany({where:{runId:run.id,...c,worldlineAnalysisJson:row.worldlineAnalysisJson},data:{worldlineAnalysisJson:JSON.stringify(analysis)}});
  return readEnding(run,c);
}
