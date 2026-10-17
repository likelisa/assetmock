import { createHash } from 'node:crypto';
import type { Run } from '@/domain/v2/types';
import { runLine } from '@/domain/worldline/kernel';
import { lineSeed, mulberry32 } from '@/domain/worldline/random';
import { distribution } from '@/domain/worldline/scalars';
import { ENDING_VERSION, SAMPLE_COUNT, RESPONSE_POLICY, type EndingAnalysisSnapshot } from '@/domain/worldline/ending';
import { sampleV2Draw, v2Driver } from '@/server/worldlines/adapter-v2/driver';
export function analysisSignature(run: Run) {
  return createHash('sha256').update(JSON.stringify({runId:run.id,runVersion:run.version,setup:run.setup,version:ENDING_VERSION,n:SAMPLE_COUNT,policy:RESPONSE_POLICY})).digest('hex');
}
/** No live ledger, default offers, parameter overrides, or model calls. */
export function calculateEnding(run: Run): EndingAnalysisSnapshot {
  if(run.status !== 'ended' || run.setup.input.custom) throw new Error('仅支持已结束的买车、买房游戏');
  const signature=analysisSignature(run), seed=parseInt(signature.slice(0,8),16);
  const driver=v2Driver(RESPONSE_POLICY);
  const lines=Array.from({length:SAMPLE_COUNT},(_,i) => {
    const rng=mulberry32(lineSeed(seed,i));
    const tape=Array.from({length:run.setup.rules.months},()=>sampleV2Draw(rng));
    const outcome=runLine({driver,setup:run.setup,tape});
    // The core carries failures forward. Detail charts stop at the actual failure month.
    for(const strategy of Object.values(outcome.strategies)) if(strategy.firstShortfall) strategy.usable=strategy.usable.slice(0,strategy.firstShortfall.month);
    return {id:`W-${String(i+1).padStart(3,'0')}`,...outcome};
  });
  const strategies=driver.describe(run.setup).map(spec=>{
    const minima=lines.map(l=>l.strategies[spec.id].minUsable), d=distribution(minima);
    return {id:spec.id,label:spec.label,floor:spec.floorMinor,failed:lines.filter(l=>l.strategies[spec.id].firstShortfall).length,minima,p5:Math.round(d.p5),p50:Math.round(d.p50),p90:Math.round(d.p90)};
  });
  const ranked=[...lines].sort((a,b)=>Math.min(...Object.values(a.strategies).map(s=>s.minUsable))-Math.min(...Object.values(b.strategies).map(s=>s.minUsable)) || a.id.localeCompare(b.id));
  return {version:ENDING_VERSION,runId:run.id,runVersion:run.version,signature,seed,rulesVersion:run.setup.rules.version,probabilities:run.setup.rules.probabilities,policy:RESPONSE_POLICY,n:SAMPLE_COUNT,months:run.setup.rules.months,createdAt:new Date().toISOString(),strategies,samples:[ranked[0],ranked[Math.floor((ranked.length-1)/2)],ranked.at(-1)!]};
}
