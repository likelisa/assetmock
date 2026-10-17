import {afterEach,describe,it,expect,vi} from 'vitest';
import {z} from 'zod';
import {agentFailure,agentModelTimeoutMs} from './agent-failures';
afterEach(()=>vi.unstubAllEnvs());
describe('agent model failures',()=>{
 it('allows slow replies while bounding every call by remaining run time',()=>{
  vi.stubEnv('AGENT_MODEL_TIMEOUT_MS','');vi.stubEnv('OPENAI_TIMEOUT_MS','');
  expect(agentModelTimeoutMs(120000)).toBe(90000);expect(agentModelTimeoutMs(18000)).toBe(18000);
  vi.stubEnv('AGENT_MODEL_TIMEOUT_MS','300000');expect(agentModelTimeoutMs(120000)).toBe(120000);
  vi.stubEnv('AGENT_MODEL_TIMEOUT_MS','15000');expect(agentModelTimeoutMs(100000)).toBe(15000);
 });
 it.each([
  [new DOMException('slow','TimeoutError'),'MODEL_TIMEOUT'],
  [new TypeError('fetch failed'),'MODEL_CONNECTION_FAILED'],
  [new Error('OPENAI_NOT_CONFIGURED'),'MODEL_NOT_CONFIGURED'],
  [new Error('OPENAI_401 secret-provider-key'),'MODEL_AUTH_FAILED'],
  [new Error('OPENAI_429 secret-provider-key'),'MODEL_RATE_LIMIT'],
  [new Error('OPENAI_503 secret-provider-key'),'MODEL_SERVICE_FAILED'],
  [new Error('OPENAI_400 secret-provider-key'),'MODEL_REQUEST_REJECTED'],
  [new Error('FINANCIAL_AGENT_DECISION_INVALID_JSON'),'MODEL_RESPONSE_INVALID'],
 ])('classifies %s without exposing provider data',(error,code)=>{
  const result=agentFailure(error);expect(result.code).toBe(code);expect(JSON.stringify(result)).not.toContain('secret-provider-key');
 });
 it('distinguishes stopped requests from timeouts and invalid model output',()=>{
  expect(agentFailure(new DOMException('stopped','AbortError'),true).code).toBe('INTERRUPTED');
  const parsed=z.object({kind:z.string()}).safeParse({});expect(parsed.success).toBe(false);if(!parsed.success)expect(agentFailure(parsed.error).code).toBe('MODEL_RESPONSE_INVALID');
 });
});
