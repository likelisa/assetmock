import {afterEach,it,expect,vi} from 'vitest';
import {db} from '@/lib/db';
import {GET} from './route';
afterEach(()=>vi.unstubAllEnvs());
it('reports the same LLM alias configuration used by model requests',async()=>{
 const w=await db.workspace.create({data:{}});
 try {
  vi.stubEnv('OPENAI_API_KEY','');vi.stubEnv('OPENAI_MODEL','');vi.stubEnv('LLM_API_KEY','test-placeholder');vi.stubEnv('LLM_MODEL','test-model');
  const request=new Request('http://localhost/api/agents',{headers:{'X-Workspace-Id':w.id}});
  const configured=await (await GET(request)).json();expect(configured.every((a:{configured:boolean})=>a.configured)).toBe(true);expect(JSON.stringify(configured)).not.toContain('test-placeholder');
  vi.stubEnv('LLM_API_KEY','');const missing=await (await GET(request)).json();expect(missing.every((a:{configured:boolean})=>!a.configured)).toBe(true);
 }finally{await db.workspace.delete({where:{id:w.id}});}
});
