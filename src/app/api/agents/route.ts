import { modelConfig } from "@/lib/model-config";
import { agentLabels, agentPrompt, AGENT_PROMPT_VERSION, type AgentKey } from "@/domain/agents";
import { assertWorkspace, apiError, getWorkspaceId } from "@/server/portfolio";
export async function GET(request: Request) { try { await assertWorkspace(getWorkspaceId(request)); const debug = new URL(request.url).searchParams.get("debug") === "1"; return Response.json(Object.entries(agentLabels).map(([key,label])=>({key,label,version:AGENT_PROMPT_VERSION,configured:Boolean(modelConfig('OPENAI').MODEL&&modelConfig('OPENAI').API_KEY),...(debug?{systemPrompt:agentPrompt(key as AgentKey,"USER_DIALOGUE")}: {})}))); } catch(e) { return apiError(e); } }
