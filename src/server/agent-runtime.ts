import { modelConfig } from "@/lib/model-config";
import { modelFetch } from "@/lib/database-maintenance";
import { z } from "zod";
import type { PlanCandidate } from "@/domain/planning";
import { DIAGNOSIS_PROMPT, DIAGNOSIS_PROMPT_VERSION } from "./diagnosis-prompt";
import { FUTURE_PLANNING_CALCULATION_PROMPT, FUTURE_PLANNING_PROMPT, FUTURE_PLANNING_PROMPT_VERSION, PLANNING_PROMPT } from "./future-planning-prompt";
import { promptVersionFor } from "./prompt-version";
import { generateReportWithProseCheck } from "./report-prose";
import type { CalculatorStep } from "@/domain/future-planning-calculator";

const PROMPT_VERSION = "wealth-agent-v1";
const model = modelConfig('OPENAI').MODEL?.trim() || "not-configured";
const OPENAI_BASE_URL = "https://api.openai.com/v1";

const diagnosisOutputSchema = z.object({
  overall_assessment: z.object({
    status: z.enum(["HEALTHY", "ATTENTION", "RISK", "INCOMPLETE", "STALE"]),
    summary: z.string().min(1).max(80),
    positive_foundations: z.array(z.string().min(1).max(120)).max(2),
  }).strict(),
  risks: z.array(z.object({
    id: z.string().min(1),
    priority: z.number().int().min(1).max(3),
    severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
    category: z.enum(["FINANCIAL_SAFETY", "ASSET_STRUCTURE", "INVESTMENT_RISK", "LIQUIDITY", "GOAL_HEALTH", "DATA_QUALITY"]),
    title: z.string().min(1).max(80),
    conclusion: z.string().min(1).max(240),
    evidence: z.array(z.string().min(1).max(200)).min(1).max(5),
    reason: z.string().min(1).max(240),
    impact: z.string().min(1).max(240),
    related_goal_ids: z.array(z.string()).max(5),
    direction: z.string().min(1).max(240),
  }).strict()).max(3),
  three_month_actions: z.array(z.object({
    id: z.string().min(1),
    risk_id: z.string().min(1),
    priority: z.enum(["P0", "P1", "P2"]),
    title: z.string().min(1).max(80),
    reason: z.string().min(1).max(240),
    steps: z.array(z.string().min(1).max(160)).min(1).max(3),
    amount: z.string().regex(/^\d+$/).nullable(),
    currency: z.literal("CNY"),
    due_in_days: z.number().int().min(1).max(90),
    prerequisites: z.array(z.string().min(1).max(160)).max(5),
    completion_criteria: z.string().min(1).max(240),
    verification_required: z.string().min(1).max(240),
  }).strict()).min(1).max(4),
  missing_information: z.array(z.object({
    field: z.string().min(1).max(80),
    why_needed: z.string().min(1).max(200),
    question: z.string().min(1).max(120),
  }).strict()).max(8),
  disclaimer: z.literal("本诊断用于资产整理与规划参考，不构成投资建议。"),
}).strict();

export type DiagnosisOutput = z.infer<typeof diagnosisOutputSchema>;

const planningNarrativeSchema = z.object({
  plans: z.array(z.object({
    key: z.enum(["A", "B", "C"]),
    summary: z.string().min(1).max(200),
    gain: z.string().min(1).max(160),
    sacrifice: z.string().min(1).max(160),
  })).length(3),
});

type AgentRun<T> = { output: T; mode: "OPENAI" | "FALLBACK"; model: string; promptVersion: string };

type AgentRequest = {
  body: Record<string, unknown>;
  url: string;
};

const futurePlanningOutputSchema = z.object({
  information_completeness: z.enum(["INSUFFICIENT", "BASIC", "COMPLETE"]),
  summary: z.string().min(1).max(400),
  assumptions: z.array(z.string().min(1).max(200)).max(5),
  risks: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    title: z.string().min(1).max(80),
    reason: z.string().min(1).max(240),
    impact: z.string().min(1).max(240),
    direction: z.string().min(1).max(240),
  }).strict()).max(3),
  actions: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    priority: z.enum(["P0", "P1", "P2"]),
    title: z.string().min(1).max(80),
    reason: z.string().min(1).max(240),
    steps: z.array(z.string().min(1).max(160)).min(1).max(3),
    amount: z.string().regex(/^\d+$/).nullable(),
    currency: z.literal("CNY"),
    due_in_days: z.number().int().min(1).max(90),
    prerequisites: z.array(z.string().min(1).max(160)).max(5),
    completion_criteria: z.string().min(1).max(240),
    verification_required: z.string().min(1).max(240),
  }).strict()).max(4),
  missing_information: z.array(z.object({
    field: z.string().min(1).max(80),
    why_needed: z.string().min(1).max(200),
    question: z.string().min(1).max(120),
  }).strict()).max(3),
  disclaimer: z.literal("本规划用于资产整理与目标规划参考，不构成投资建议。"),
}).strict().superRefine((value, context) => {
  if (value.information_completeness === "INSUFFICIENT" && value.missing_information.length === 0) {
    context.addIssue({ code: "custom", message: "信息不足时必须提出待补充问题" });
  }
  if (value.information_completeness !== "INSUFFICIENT" && value.actions.length === 0) {
    context.addIssue({ code: "custom", message: "信息可用时必须生成行动" });
  }
});

export type FuturePlanningOutput = z.infer<typeof futurePlanningOutputSchema>;

export function parseFuturePlanningOutput(value: unknown) {
  return futurePlanningOutputSchema.parse(value);
}

export const futurePlanningJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["information_completeness", "summary", "assumptions", "risks", "actions", "missing_information", "disclaimer"],
  properties: {
    information_completeness: { type: "string", enum: ["INSUFFICIENT", "BASIC", "COMPLETE"] },
    summary: { type: "string", maxLength: 400 },
    assumptions: { type: "array", maxItems: 5, items: { type: "string", maxLength: 200 } },
    risks: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["id", "title", "reason", "impact", "direction"], properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" }, title: { type: "string", maxLength: 80 }, reason: { type: "string", maxLength: 240 }, impact: { type: "string", maxLength: 240 }, direction: { type: "string", maxLength: 240 },
    } } },
    actions: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["id", "priority", "title", "reason", "steps", "amount", "currency", "due_in_days", "prerequisites", "completion_criteria", "verification_required"], properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" }, priority: { type: "string", enum: ["P0", "P1", "P2"] }, title: { type: "string", maxLength: 80 }, reason: { type: "string", maxLength: 240 },
      steps: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 160 } }, amount: { anyOf: [{ type: "string", pattern: "^\\d+$" }, { type: "null" }] }, currency: { type: "string", enum: ["CNY"] },
      due_in_days: { type: "integer", minimum: 1, maximum: 90 }, prerequisites: { type: "array", maxItems: 5, items: { type: "string", maxLength: 160 } }, completion_criteria: { type: "string", maxLength: 240 }, verification_required: { type: "string", maxLength: 240 },
    } } },
    missing_information: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["field", "why_needed", "question"], properties: { field: { type: "string", maxLength: 80 }, why_needed: { type: "string", maxLength: 200 }, question: { type: "string", maxLength: 120 } } } },
    disclaimer: { type: "string", enum: ["本规划用于资产整理与目标规划参考，不构成投资建议。"] },
  },
};

const calculationPlanSchema = z.object({
  formula_ids: z.array(z.enum(["goal_funding", "emergency_coverage", "resignation_reserve", "home_initial_fund"])).max(4),
  custom_steps: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label: z.string().min(1).max(80),
    operation: z.enum(["ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "MIN", "MAX", "POWER"]),
    operands: z.array(z.union([
      z.object({ type: z.literal("FACT"), id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
      z.object({ type: z.literal("STEP"), id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
      z.object({ type: z.literal("LITERAL"), value: z.string().regex(/^-?\d+(\.\d+)?$/), unit: z.enum(["CNY_MINOR", "COUNT", "MONTHS", "RATIO", "DIMENSIONLESS"]) }).strict(),
    ])).min(2).max(6),
    unit: z.enum(["CNY_MINOR", "COUNT", "MONTHS", "RATIO", "DIMENSIONLESS"]),
    rounding: z.enum(["NONE", "CEIL", "FLOOR", "HALF_UP"]).optional(),
    decimalPlaces: z.number().int().min(0).max(12).optional(),
  }).strict()).max(6),
}).strict();

const calculationPlanJsonSchema = {
  type: "object", additionalProperties: false, required: ["formula_ids", "custom_steps"], properties: {
    formula_ids: { type: "array", maxItems: 4, items: { type: "string", enum: ["goal_funding", "emergency_coverage", "resignation_reserve", "home_initial_fund"] } },
    custom_steps: { type: "array", maxItems: 6, items: {
      type: "object", additionalProperties: false, required: ["id", "label", "operation", "operands", "unit"], properties: {
        id: { type: "string" }, label: { type: "string", maxLength: 80 }, operation: { type: "string", enum: ["ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "MIN", "MAX", "POWER"] },
        operands: { type: "array", minItems: 2, maxItems: 6, items: { type: "object" } }, unit: { type: "string", enum: ["CNY_MINOR", "COUNT", "MONTHS", "RATIO", "DIMENSIONLESS"] }, rounding: { type: "string", enum: ["NONE", "CEIL", "FLOOR", "HALF_UP"] }, decimalPlaces: { type: "integer", minimum: 0, maximum: 12 },
      },
    } },
  },
};

export type FuturePlanningCalculationPlan = { formulaIds: string[]; customSteps: CalculatorStep[]; mode: "OPENAI" | "FALLBACK" };

function normalizeBaseUrl(value: string | undefined) {
  return (value?.trim() || OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function runtimeDateTime(now = new Date(), timeZone = process.env.APP_TIMEZONE?.trim() || "Asia/Shanghai") {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  return {
    currentDate: `${parts.year}-${parts.month}-${parts.day}`,
    currentTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone,
  };
}

function instructionsWithRuntimeTime(instructions: string) {
  const context = runtimeDateTime();
  return `${instructions}\n【运行时日期与时间】当前日期：${context.currentDate}；当前时间：${context.currentTime}；时区：${context.timeZone}。此信息由服务器系统时间提供。`;
}

export function buildAgentRequest(
  baseUrlValue: string | undefined,
  configuredModel: string,
  instructions: string,
  input: unknown,
  schemaName: string,
  schema: object,
): AgentRequest {
  const baseUrl = normalizeBaseUrl(baseUrlValue);
  const runtimeInstructions = instructionsWithRuntimeTime(instructions);
  if (baseUrl === OPENAI_BASE_URL) {
    return {
      url: `${baseUrl}/responses`,
      body: {
        model: configuredModel,
        store: false,
        max_output_tokens: modelMaxOutputTokens(),
        instructions: runtimeInstructions,
        input: JSON.stringify(input),
        text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
      },
    };
  }

  return {
    url: `${baseUrl}/chat/completions`,
    body: {
      model: configuredModel,
      stream: false,
      max_tokens: modelMaxOutputTokens(),
      messages: [
        {
          role: "system",
          content: `${runtimeInstructions}\n请只返回符合以下 JSON Schema 的对象，不得增加、删除或重命名字段。Schema 名称：${schemaName}\n${JSON.stringify(schema)}`,
        },
        { role: "user", content: JSON.stringify(input) },
      ],
      response_format: { type: "json_object" },
    },
  };
}

function extractResponseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  const chatContent = choices?.[0]?.message?.content;
  if (chatContent) return chatContent;

  const output = payload.output as Array<{ content?: Array<{ type: string; text?: string }> }> | undefined;
  return output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
}

async function providerError(response: Response, apiKey: string, prefix: string) {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  const error = payload?.error;
  const message = typeof error === "string"
    ? error
    : error && typeof error === "object" && "message" in error
      ? String(error.message)
      : typeof payload?.msg === "string"
        ? payload.msg
        : typeof payload?.message === "string"
          ? payload.message
          : "";
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const detail = [code, message].filter(Boolean).join(": ").replaceAll(apiKey, "[redacted]").slice(0, 240);
  return new Error(`${prefix}_${response.status}${detail ? ` ${detail}` : ""}`);
}

type MultimodalContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export async function structuredMultimodalResponse<T>(instructions: string, content: MultimodalContent[], schemaName: string, schema: object): Promise<T> {
  const apiKey = modelConfig('OPENAI').API_KEY?.trim();
  const configuredModel = process.env.OPENAI_VISION_MODEL?.trim()
    || (modelConfig('OPENAI').BASE_URL?.includes("aiping.cn") ? "Qwen3-VL-30B-A3B-Instruct" : "");
  if (!apiKey || !configuredModel) throw new Error("VISION_MODEL_NOT_CONFIGURED");
  const baseUrl = normalizeBaseUrl(modelConfig('OPENAI').BASE_URL);
  const schemaInstruction = `${instructionsWithRuntimeTime(instructions)}\n请只返回符合以下 JSON Schema 的对象，不得增加、删除或重命名字段。Schema 名称：${schemaName}\n${JSON.stringify(schema)}`;
  const request = baseUrl === OPENAI_BASE_URL
    ? {
        url: `${baseUrl}/responses`,
        body: {
          model: configuredModel, store: false, max_output_tokens: modelMaxOutputTokens(), instructions: schemaInstruction,
          input: [{ role: "user", content: content.map((item) => item.type === "text" ? { type: "input_text", text: item.text } : { type: "input_image", image_url: item.image_url.url }) }],
          text: { format: { type: "json_schema", name: schemaName, strict: true, schema } },
        },
      }
    : {
        url: `${baseUrl}/chat/completions`,
        body: {
          model: configuredModel, stream: false, max_tokens: modelMaxOutputTokens(),
          messages: [{ role: "system", content: schemaInstruction }, { role: "user", content }],
          response_format: { type: "json_object" },
        },
      };
  const response = await modelFetch(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(modelTimeoutMs()),
  });
  if (!response.ok) throw new Error(`VISION_MODEL_${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const text = extractResponseText(payload);
  if (!text) throw new Error("VISION_MODEL_EMPTY_OUTPUT");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${schemaName.toUpperCase()}_INVALID_JSON`);
  }
}

export async function structuredResponse<T>(instructions: string, input: unknown, schemaName: string, schema: object, timeoutMs = modelTimeoutMs(), signal?: AbortSignal): Promise<T> {
  if (process.env.NODE_ENV === "test" && process.env.ALLOW_AI_IN_TEST !== "true") throw new Error("OPENAI_DISABLED_IN_TEST");
  const apiKey = modelConfig('OPENAI').API_KEY?.trim();
  const configuredModel = modelConfig('OPENAI').MODEL?.trim();
  if (!apiKey || !configuredModel) throw new Error("OPENAI_NOT_CONFIGURED");
  const request = buildAgentRequest(
    modelConfig('OPENAI').BASE_URL,
    configuredModel,
    instructions,
    input,
    schemaName,
    schema,
  );
  const response = await modelFetch(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await providerError(response, apiKey, "OPENAI");
  const payload = await response.json() as Record<string, unknown>;
  const text = extractResponseText(payload);
  if (!text) throw new Error("OPENAI_EMPTY_OUTPUT");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${schemaName.toUpperCase()}_INVALID_JSON`);
  }
}

export async function textResponse(instructions: string, input: unknown): Promise<string> {
  if (process.env.NODE_ENV === "test" && process.env.ALLOW_AI_IN_TEST !== "true") throw new Error("OPENAI_DISABLED_IN_TEST");
  const apiKey = modelConfig('OPENAI').API_KEY?.trim();
  const configuredModel = modelConfig('OPENAI').MODEL?.trim();
  if (!apiKey || !configuredModel) throw new Error("OPENAI_NOT_CONFIGURED");
  const baseUrl = normalizeBaseUrl(modelConfig('OPENAI').BASE_URL);
  const request = baseUrl === OPENAI_BASE_URL
    ? {
        url: `${baseUrl}/responses`,
        body: {
          model: configuredModel,
          store: false,
          max_output_tokens: modelMaxOutputTokens(),
          instructions: instructionsWithRuntimeTime(instructions),
          input: JSON.stringify(input),
        },
      }
    : {
        url: `${baseUrl}/chat/completions`,
        body: {
          model: configuredModel,
          stream: false,
          max_tokens: modelMaxOutputTokens(),
          messages: [
            { role: "system", content: instructionsWithRuntimeTime(instructions) },
            { role: "user", content: JSON.stringify(input) },
          ],
        },
      };
  const response = await modelFetch(request.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(modelTimeoutMs()),
  });
  if (!response.ok) throw new Error(`OPENAI_${response.status}`);
  const payload = await response.json() as Record<string, unknown>;
  const text = extractResponseText(payload)?.trim();
  if (!text) throw new Error("OPENAI_EMPTY_OUTPUT");
  return text;
}

function modelTimeoutMs() {
  const configured = Number(process.env.OPENAI_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(configured) ? Math.min(120_000, Math.max(5_000, configured)) : 60_000;
}

function modelMaxOutputTokens() {
  const configured = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 8_192);
  return Number.isFinite(configured) ? Math.min(16_384, Math.max(1_024, Math.round(configured))) : 8_192;
}

export const diagnosisJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["overall_assessment", "risks", "three_month_actions", "missing_information", "disclaimer"],
  properties: {
    overall_assessment: {
      type: "object", additionalProperties: false,
      required: ["status", "summary", "positive_foundations"],
      properties: {
        status: { type: "string", enum: ["HEALTHY", "ATTENTION", "RISK", "INCOMPLETE", "STALE"] },
        summary: { type: "string", maxLength: 80 },
        positive_foundations: { type: "array", maxItems: 2, items: { type: "string" } },
      },
    },
    risks: {
      type: "array", maxItems: 3,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "priority", "severity", "category", "title", "conclusion", "evidence", "reason", "impact", "related_goal_ids", "direction"],
        properties: {
          id: { type: "string" }, priority: { type: "integer", minimum: 1, maximum: 3 },
          severity: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
          category: { type: "string", enum: ["FINANCIAL_SAFETY", "ASSET_STRUCTURE", "INVESTMENT_RISK", "LIQUIDITY", "GOAL_HEALTH", "DATA_QUALITY"] },
          title: { type: "string" }, conclusion: { type: "string" },
          evidence: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
          reason: { type: "string" }, impact: { type: "string" },
          related_goal_ids: { type: "array", items: { type: "string" } }, direction: { type: "string" },
        },
      },
    },
    three_month_actions: {
      type: "array", minItems: 1, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "risk_id", "priority", "title", "reason", "steps", "amount", "currency", "due_in_days", "prerequisites", "completion_criteria", "verification_required"],
        properties: {
          id: { type: "string" }, risk_id: { type: "string" }, priority: { type: "string", enum: ["P0", "P1", "P2"] },
          title: { type: "string" }, reason: { type: "string" },
          steps: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
          amount: { anyOf: [{ type: "string", pattern: "^\\d+$" }, { type: "null" }] }, currency: { type: "string", enum: ["CNY"] },
          due_in_days: { type: "integer", minimum: 1, maximum: 90 },
          prerequisites: { type: "array", items: { type: "string" } },
          completion_criteria: { type: "string" }, verification_required: { type: "string" },
        },
      },
    },
    missing_information: {
      type: "array", maxItems: 8,
      items: { type: "object", additionalProperties: false, required: ["field", "why_needed", "question"], properties: { field: { type: "string" }, why_needed: { type: "string" }, question: { type: "string" } } },
    },
    disclaimer: { type: "string", enum: ["本诊断用于资产整理与规划参考，不构成投资建议。"] },
  },
};

export const planningJsonSchema = {
  type: "object", additionalProperties: false, required: ["plans"],
  properties: { plans: { type: "array", minItems: 3, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["key", "summary", "gain", "sacrifice"], properties: { key: { type: "string", enum: ["A", "B", "C"] }, summary: { type: "string" }, gain: { type: "string" }, sacrifice: { type: "string" } } } } },
};

export async function runDiagnosisNarrative(input: Record<string, unknown>, instructions = DIAGNOSIS_PROMPT): Promise<AgentRun<DiagnosisOutput>> {
  const output = await generateReportWithProseCheck(instructions, input, async (prompt, data) =>
    diagnosisOutputSchema.parse(await structuredResponse<unknown>(prompt, data, "wealth_diagnosis", diagnosisJsonSchema)));
  const returnedRiskIds = new Set(output.risks.map((risk) => risk.id));
  if (output.three_month_actions.some((action) => !returnedRiskIds.has(action.risk_id))) throw new Error("INVALID_ACTION_REFERENCE");
  const adjustableAmounts = input.adjustable_amounts as Array<{ amount_minor?: string }> | undefined;
  const allowedAmounts = new Set((adjustableAmounts ?? []).flatMap((item) => item.amount_minor ? [item.amount_minor] : []));
  if (output.three_month_actions.some((action) => action.amount !== null && !allowedAmounts.has(action.amount))) throw new Error("INVALID_AMOUNT_REFERENCE");
  return { output, mode: "OPENAI", model: modelConfig('OPENAI').MODEL!, promptVersion: promptVersionFor(DIAGNOSIS_PROMPT_VERSION, instructions, DIAGNOSIS_PROMPT) };
}

export async function runPlanningNarrative(candidates: PlanCandidate[], instructions = PLANNING_PROMPT): Promise<AgentRun<z.infer<typeof planningNarrativeSchema>>> {
  const fallback = { plans: candidates.map((plan) => ({
    key: plan.key,
    summary: plan.principle,
    gain: plan.key === "A" ? "更接近原定目标时间与金额。" : plan.key === "B" ? "在目标进度和现金流之间保留平衡。" : "现金流与应急能力更稳健。",
    sacrifice: plan.key === "A" ? "每月可支配结余减少。" : plan.key === "B" ? "可能需要调整目标预算或投入节奏。" : "目标完成日期可能延后。",
  })) };
  if (candidates.length !== 3) return { output: fallback, mode: "FALLBACK", model, promptVersion: PROMPT_VERSION };
  try {
    const raw = await structuredResponse<unknown>(
      instructions,
      { candidates },
      "wealth_planning",
      planningJsonSchema,
    );
    const output = planningNarrativeSchema.parse(raw);
    if (new Set(output.plans.map((plan) => plan.key)).size !== 3) throw new Error("DUPLICATE_PLAN_KEY");
    return { output, mode: "OPENAI", model: modelConfig('OPENAI').MODEL!, promptVersion: promptVersionFor(PROMPT_VERSION, instructions, PLANNING_PROMPT) };
  } catch {
    return { output: fallback, mode: "FALLBACK", model, promptVersion: promptVersionFor(PROMPT_VERSION, instructions, PLANNING_PROMPT) };
  }
}

export async function selectFuturePlanningCalculations(input: Record<string, unknown>): Promise<FuturePlanningCalculationPlan> {
  const fallback = { formulaIds: ["goal_funding", "emergency_coverage"], customSteps: [] as CalculatorStep[], mode: "FALLBACK" as const };
  try {
    const raw = await structuredResponse<unknown>(FUTURE_PLANNING_CALCULATION_PROMPT, input, "future_planning_calculation_plan", calculationPlanJsonSchema);
    const output = calculationPlanSchema.parse(raw);
    if (new Set(output.formula_ids).size !== output.formula_ids.length || new Set(output.custom_steps.map((step) => step.id)).size !== output.custom_steps.length) throw new Error("DUPLICATE_CALCULATION_PLAN_ID");
    return { formulaIds: output.formula_ids, customSteps: output.custom_steps, mode: "OPENAI" };
  } catch {
    return fallback;
  }
}

export async function runFuturePlanningReport(input: Record<string, unknown>, instructions = FUTURE_PLANNING_PROMPT): Promise<AgentRun<FuturePlanningOutput>> {
  const calculatorResult = input.calculator_result as { calculations?: Array<{ value?: string; unit?: string }> } | undefined;
  const selectedPlan = input.selected_plan as Record<string, unknown> | undefined;
  const planAmountFields = ["targetAmountMinor", "monthlyContributionMinor", "monthlyCashflowAfterContributionMinor", "immediateReserveGapMinor", "projectedAmountMinor", "projectedGapMinor"];
  const allowedAmounts = new Set([
    ...(calculatorResult?.calculations ?? []).filter((item) => item.unit === "CNY_MINOR" && typeof item.value === "string").map((item) => item.value!),
    ...planAmountFields.flatMap((field) => typeof selectedPlan?.[field] === "string" && /^\d+$/.test(selectedPlan[field] as string) ? [selectedPlan[field] as string] : []),
  ]);
  const raw = await structuredResponse<unknown>(instructions, { ...input, allowed_action_amounts_minor: [...allowedAmounts] }, "future_planning_action", futurePlanningJsonSchema, 120_000);
  const output = futurePlanningOutputSchema.parse(raw);
  if (new Set(output.actions.map((action) => action.id)).size !== output.actions.length) throw new Error("DUPLICATE_FUTURE_ACTION_ID");
  if (output.actions.some((action) => action.amount !== null && !allowedAmounts.has(action.amount))) throw new Error("INVALID_FUTURE_ACTION_AMOUNT");
  return {
    output,
    mode: "OPENAI",
    model: modelConfig('OPENAI').MODEL!,
    promptVersion: promptVersionFor(FUTURE_PLANNING_PROMPT_VERSION, instructions, FUTURE_PLANNING_PROMPT),
  };
}

export function formatFuturePlanningReport(output: FuturePlanningOutput) {
  const completeness = { INSUFFICIENT: "不足", BASIC: "基本够用", COMPLETE: "完整" }[output.information_completeness];
  const lines = [`【未来规划行动清单】`, `信息完整度：${completeness}`, output.summary];
  if (output.assumptions.length) lines.push(`主要假设：${output.assumptions.join("；")}`);
  if (output.risks.length) lines.push(`风险提示：${output.risks.map((risk) => `${risk.title}：${risk.impact}`).join("；")}`);
  for (const action of output.actions) lines.push(`${action.priority} ${action.title}（${action.due_in_days}天内）：${action.reason}\n完成标准：${action.completion_criteria}`);
  if (output.missing_information.length) lines.push(`待确认：${output.missing_information.map((item) => item.question).join("；")}`);
  lines.push(output.disclaimer);
  return lines.join("\n\n");
}
