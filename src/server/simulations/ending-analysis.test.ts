import { describe,it,expect,afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { demoSetup,makeRunLike } from '@/server/worldlines/adapter-v2/setup';
import { calculateEnding } from './ending-calculation';
import { generateEnding,readEnding } from './ending-analysis';
import { sharedEdges,histogram,riskOf } from '@/domain/worldline/ending';
const workspaces:string[]=[];
afterAll(async()=>{await db.simulationReport.deleteMany({where:{workspaceId:{in:workspaces}}});await db.workspace.deleteMany({where:{id:{in:workspaces}}});});
function ended(){ const run=makeRunLike(demoSetup(),[]);run.status='ended';run.version=4;run.id=randomUUID();return run; }
describe('frozen ending analysis',()=>{
 it('reproduces 200 paired samples without mutating frozen inputs or substituting loan terms',()=>{
  const run=ended();run.setup.plans.b.term=24;run.setup.plans.b.payment=123456;run.setup.plans.b.offer.annualRate='0.0123';
  const before=JSON.stringify(run),a=calculateEnding(run),b=calculateEnding(run);
  expect({...a,createdAt:''}).toEqual({...b,createdAt:''});expect(JSON.stringify(run)).toBe(before);
  expect(a.strategies.every(s=>s.minima.length===200)).toBe(true);
  const other=structuredClone(run);other.setup.plans.b.payment+=100000;
  expect(calculateEnding(other).signature).not.toBe(a.signature);
 });
 it('same plans share every draw and automatic choice; fails early without invented continuation',()=>{
  const run=ended();run.setup.plans.b=structuredClone(run.setup.plans.a);
  run.setup.profile.cash=run.setup.plans.a.down+1;run.setup.profile.salary=0;run.setup.profile.fund=0;
  const a=calculateEnding(run);expect(a.strategies[0].minima).toEqual(a.strategies[1].minima);
  expect(a.strategies[0].failed).toBe(200);
  for(const sample of a.samples) for(const s of Object.values(sample.strategies)) expect(s.usable.length).toBe(s.firstShortfall?.month);
 });
 it('supports a full 360 month home horizon',()=>{
  const run=ended();run.setup=demoSetup('HOME-U02','home',100000000);
  const a=calculateEnding(run);expect(a.months).toBe(360);expect(a.n).toBe(200);
 });
 it('uses common bins and exact counts at thresholds including zero',()=>{
  const values=Array.from({length:200},(_,i)=>i-50),edges=sharedEdges(values,[0,100,125]);
  const bins=histogram(values,edges);expect(bins.reduce((s,b)=>s+b.count,0)).toBe(200);expect(bins.reduce((s,b)=>s+b.share,0)).toBeCloseTo(1);
  expect(edges).toEqual(expect.arrayContaining([0,100,125]));expect(riskOf(0,100).label).toBe('低于储备门槛');expect(riskOf(100,100).label).toBe('贴近门槛');expect(riskOf(125,100).label).toBe('有余量');
 });
 it('persists idempotently, isolates owners, validates version and keeps historical inputs',async()=>{
  const w=await db.workspace.create({data:{}});workspaces.push(w.id);const c={workspaceId:w.id,sessionId:randomUUID()};
  const run=ended();run.sessionId=`integrated:${w.id}:${c.sessionId}`;
  expect((await readEnding(run,c)).analysis).toBeNull();
  const [a,b]=await Promise.all([generateEnding(run,c,4),generateEnding(run,c,4)]);expect(a).toEqual(b);
  expect(await db.simulationReport.count({where:{runId:run.id}})).toBe(1);
  await db.workspace.update({where:{id:w.id},data:{portfolioRevision:7}});
  expect(await readEnding(run,c)).toEqual(a);
  await expect(readEnding(run,{...c,sessionId:'foreign'})).rejects.toMatchObject({status:404});
  await expect(generateEnding(run,c,3)).rejects.toMatchObject({status:409});
  run.status='running';await expect(generateEnding(run,c,4)).rejects.toMatchObject({status:422});
 });
});
