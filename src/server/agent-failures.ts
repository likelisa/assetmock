import { z } from 'zod';
import { ApiError } from './portfolio';

export const AGENT_RUN_TIMEOUT_MS = 120_000;
/** Leave the last seconds to persist a result before the route's 130s limit. */
export function agentModelTimeoutMs(remainingMs: number) {
  const value = Number(process.env.AGENT_MODEL_TIMEOUT_MS ?? process.env.OPENAI_TIMEOUT_MS ?? 90_000);
  const configured = Number.isFinite(value) && value > 0 ? value : 90_000;
  return Math.max(1, Math.min(120_000, Math.max(5_000, configured), remainingMs));
}

/** Never return raw provider bodies, credentials, or model-generated values. */
export function agentFailure(error: unknown, interrupted = false) {
  if (interrupted) return { code: 'INTERRUPTED', message: '处理已中断，消息已保留，可以继续上次处理。' };
  if (error instanceof ApiError) return { code: String(error.status), message: error.message };
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { code: 'MODEL_TIMEOUT', message: '模型回复超时，消息和已完成的核对已保留。请点击“继续上次未完成的处理”重试。' };
  if (message === 'OPENAI_NOT_CONFIGURED') return { code: 'MODEL_NOT_CONFIGURED', message: '尚未配置模型，请检查模型名称和 API 密钥后重启服务。资料与计算功能仍可使用。' };
  if (/^OPENAI_(401|403)\b/.test(message)) return { code: 'MODEL_AUTH_FAILED', message: '模型服务拒绝访问，请检查 API 密钥和模型使用权限。' };
  if (/^OPENAI_429\b/.test(message)) return { code: 'MODEL_RATE_LIMIT', message: '模型服务限流或额度不足，请稍后重试并检查服务额度。' };
  if (/^OPENAI_5\d\d\b/.test(message)) return { code: 'MODEL_SERVICE_FAILED', message: '模型服务暂时异常，消息已保留，请稍后继续处理。' };
  if (/^OPENAI_4\d\d\b/.test(message)) return { code: 'MODEL_REQUEST_REJECTED', message: '模型服务不接受当前请求，请核对模型名称、接口地址和结构化输出支持。' };
  if (error instanceof z.ZodError || /_INVALID_JSON$/.test(message) || message === 'OPENAI_EMPTY_OUTPUT') return { code: 'MODEL_RESPONSE_INVALID', message: '模型返回的内容格式不完整，未执行新的操作。请继续上次处理以重新生成。' };
  if (name === 'TypeError' && /fetch|network/i.test(message)) return { code: 'MODEL_CONNECTION_FAILED', message: '暂时无法连接模型服务，请检查网络或接口地址后继续处理。' };
  return { code: 'MODEL_OR_TOOL_FAILED', message: '本次模型或工具处理失败，消息已保留，请继续上次处理或使用页面中的计算功能。' };
}
