import {
  BorrowVsSellInputSchema,
  CheckTaxImpactRequestSchema,
  ClaimDossierInputSchema,
  DeductibleExpenseInputSchema,
  PrepareExecutionInputSchema,
} from "@taxrail/shared";
import { buildAgentCard } from "./discovery.js";
import type { Env } from "./env.js";
import {
  normalizeBorrowVsSellPayload,
  normalizeCheckTaxImpactPayload,
  normalizeClassifyExpensePayload,
} from "./normalizers.js";
import type { PlanStore } from "./plan-store.js";
import {
  executeBorrowVsSell,
  executeBr35kStatus,
  executeCheckTaxImpact,
  executeClaimDossier,
  executeClassifyExpense,
  executePrepareExecution,
} from "./service.js";

export interface A2aPart {
  kind?: string;
  type?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface A2aMessage {
  kind?: "message";
  messageId?: string;
  role?: string;
  contextId?: string;
  taskId?: string;
  parts: A2aPart[];
}

export interface A2aTask {
  id: string;
  contextId: string;
  kind: "task";
  status: {
    state: "completed" | "TASK_STATE_COMPLETED" | "failed" | "TASK_STATE_FAILED";
    timestamp: string;
    message?: A2aMessage;
  };
  artifacts?: Array<{
    artifactId: string;
    name: string;
    parts: A2aPart[];
  }>;
  history?: A2aMessage[];
}

const MEMORY_A2A_TASKS = new Map<string, A2aTask>();
const TASK_TTL_SECONDS = 15 * 60;

async function saveA2aTask(env: Env, task: A2aTask): Promise<void> {
  if (env.TAXRAIL_PLANS) {
    await env.TAXRAIL_PLANS.put(`a2a_task:${task.id}`, JSON.stringify(task), {
      expirationTtl: TASK_TTL_SECONDS,
    });
  } else {
    MEMORY_A2A_TASKS.set(task.id, task);
  }
}

async function loadA2aTask(env: Env, taskId: string): Promise<A2aTask | null> {
  if (env.TAXRAIL_PLANS) {
    const raw = await env.TAXRAIL_PLANS.get(`a2a_task:${taskId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as A2aTask;
    } catch {
      return null;
    }
  }
  return MEMORY_A2A_TASKS.get(taskId) ?? null;
}

function jsonRpcSuccess(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result }, { status: 200 });
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: id ?? null,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    },
    { status: 200 }
  );
}

function extractMessageContent(message: A2aMessage): {
  dataPayload?: Record<string, unknown>;
  textInput: string;
} {
  let dataPayload: Record<string, unknown> | undefined;
  const textChunks: string[] = [];

  for (const part of message.parts || []) {
    if (part.data && typeof part.data === "object" && !Array.isArray(part.data)) {
      dataPayload = part.data;
    } else if (typeof part.text === "string" && part.text.trim()) {
      const trimmed = part.text.trim();
      textChunks.push(trimmed);
      if (!dataPayload && trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            dataPayload = parsed as Record<string, unknown>;
          }
        } catch {
          // Plain natural-language text
        }
      }
    }
  }

  return { dataPayload, textInput: textChunks.join("\n").trim() };
}

function detectRequestedSkill(
  data: Record<string, unknown>
):
  | "check_tax_impact"
  | "compare_borrow_vs_sell"
  | "classify_deductible_expense"
  | "prepare_execution"
  | "claim_dossier"
  | "check_br_35k_status" {
  const explicit =
    typeof data.skill === "string"
      ? data.skill.trim().toLowerCase()
      : typeof data.action === "string"
        ? data.action.trim().toLowerCase()
        : "";

  if (explicit === "compare_borrow_vs_sell" || explicit === "borrow_vs_sell") {
    return "compare_borrow_vs_sell";
  }
  if (explicit === "classify_deductible_expense" || explicit === "classify_expense") {
    return "classify_deductible_expense";
  }
  if (explicit === "prepare_execution") return "prepare_execution";
  if (explicit === "claim_dossier") return "claim_dossier";
  if (explicit === "check_br_35k_status" || explicit === "br_35k_status") {
    return "check_br_35k_status";
  }
  if (explicit === "check_tax_impact") return "check_tax_impact";

  if (typeof data.planId === "string" && typeof data.txHash === "string") {
    return "claim_dossier";
  }
  if (typeof data.planId === "string") {
    return "prepare_execution";
  }
  if (
    data.collateralAsset !== undefined ||
    data.collateral_asset !== undefined ||
    data.liquidityNeededUsd !== undefined ||
    data.liquidity_needed_usd !== undefined
  ) {
    return "compare_borrow_vs_sell";
  }
  if (
    data.vendorName !== undefined ||
    data.vendor !== undefined ||
    data.vendor_name !== undefined
  ) {
    return "classify_deductible_expense";
  }
  if (data.monthlySalesBrl !== undefined || data.plannedSaleUsd !== undefined) {
    return "check_br_35k_status";
  }
  return "check_tax_impact";
}

async function runA2aSkillExecution(params: {
  message: A2aMessage;
  deps: { planStore: PlanStore; env: Env };
  requestUrl: string;
}): Promise<{ skillName: string; summaryText: string; resultData: Record<string, unknown> }> {
  const { dataPayload, textInput } = extractMessageContent(params.message);

  if (dataPayload) {
    const skill = detectRequestedSkill(dataPayload);

    if (skill === "compare_borrow_vs_sell") {
      const normalized = normalizeBorrowVsSellPayload(dataPayload);
      const parsed = BorrowVsSellInputSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          skillName: skill,
          summaryText: `Validation failed for compare_borrow_vs_sell: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
          resultData: { error: "Validation failed", issues: parsed.error.issues },
        };
      }
      const res = await executeBorrowVsSell(parsed.data, params.deps);
      return {
        skillName: skill,
        summaryText: `TaxRail Aave v3 borrow-vs-sell (${parsed.data.jurisdiction}): taxSavedUsd=$${res.taxSavedUsd.toFixed(2)}, planId=${res.planId}. Next: call prepare_execution for $0-upfront atomicBatchCalls.`,
        resultData: res as unknown as Record<string, unknown>,
      };
    }

    if (skill === "classify_deductible_expense") {
      const normalized = normalizeClassifyExpensePayload(dataPayload);
      const parsed = DeductibleExpenseInputSchema.safeParse(normalized);
      if (!parsed.success) {
        return {
          skillName: skill,
          summaryText: `Validation failed for classify_deductible_expense: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
          resultData: { error: "Validation failed", issues: parsed.error.issues },
        };
      }
      const res = await executeClassifyExpense(parsed.data, params.deps);
      return {
        skillName: skill,
        summaryText: `TaxRail expense classification (${parsed.data.jurisdiction}/${parsed.data.regime}): taxSavedUsd=$${res.taxSavedUsd.toFixed(2)}, planId=${res.planId}.`,
        resultData: res as unknown as Record<string, unknown>,
      };
    }

    if (skill === "prepare_execution") {
      const parsed = PrepareExecutionInputSchema.safeParse(dataPayload);
      if (!parsed.success) {
        return {
          skillName: skill,
          summaryText: `Validation failed for prepare_execution: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
          resultData: { error: "Validation failed", issues: parsed.error.issues },
        };
      }
      const res = await executePrepareExecution(parsed.data, params.deps);
      if (!res.ok) {
        return {
          skillName: skill,
          summaryText: `prepare_execution returned ${res.status}: ${res.error}`,
          resultData: { status: res.status, error: res.error },
        };
      }
      return {
        skillName: skill,
        summaryText: `Prepared $0-upfront 1-click execution (${res.data.executionPayload.type}) for planId=${res.data.planId}. Upfront cost=$0; 10% fee=$${res.data.feePaidFromOperationUsd.toFixed(2)} collected from operation proceeds.`,
        resultData: res.data as unknown as Record<string, unknown>,
      };
    }

    if (skill === "claim_dossier") {
      const parsed = ClaimDossierInputSchema.safeParse(dataPayload);
      if (!parsed.success) {
        return {
          skillName: skill,
          summaryText: `Validation failed for claim_dossier: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
          resultData: { error: "Validation failed", issues: parsed.error.issues },
        };
      }
      const res = await executeClaimDossier(parsed.data, params.deps);
      if (!res.ok) {
        return {
          skillName: skill,
          summaryText: `claim_dossier returned ${res.status}: ${res.error}`,
          resultData: {
            status: res.status,
            error: res.error,
            ...(res.explorerUrl ? { explorerUrl: res.explorerUrl } : {}),
          },
        };
      }
      return {
        skillName: skill,
        summaryText: `Verified on-chain receipt ${res.data.settlementTx} and unlocked SpecID dossier (${res.data.plan.accountingDossier.format}).`,
        resultData: res.data as unknown as Record<string, unknown>,
      };
    }

    if (skill === "check_br_35k_status") {
      const monthlySalesBrl = Number(dataPayload.monthlySalesBrl ?? 0) || 0;
      const plannedSaleUsd = Number(dataPayload.plannedSaleUsd ?? 1000) || 1000;
      const custodyLocation =
        String(dataPayload.custodyLocation || "DOMESTIC").toUpperCase() === "OFFSHORE"
          ? "OFFSHORE"
          : "DOMESTIC";
      const res = executeBr35kStatus({
        monthlySalesBrl,
        plannedSaleUsd,
        custodyLocation,
      });
      return {
        skillName: skill,
        summaryText: `Brazil R$35k check: status=${res.status}, remainingExemptBrl=${res.remainingExemptBrl.toFixed(2)}.`,
        resultData: res as unknown as Record<string, unknown>,
      };
    }

    const normalized = normalizeCheckTaxImpactPayload(dataPayload);
    const parsed = CheckTaxImpactRequestSchema.safeParse(normalized);
    if (!parsed.success) {
      return {
        skillName: "check_tax_impact",
        summaryText: `Validation failed for check_tax_impact: ${parsed.error.issues[0]?.message ?? "invalid payload"}`,
        resultData: { error: "Validation failed", issues: parsed.error.issues },
      };
    }
    const res = await executeCheckTaxImpact(parsed.data, params.deps);
    return {
      skillName: "check_tax_impact",
      summaryText: `TaxRail check_tax_impact (${parsed.data.jurisdiction}): baseline=$${res.baselineTaxUsd.toFixed(2)}, optimized=$${res.optimizedTaxUsd.toFixed(2)}, taxSavedUsd=$${res.taxSavedUsd.toFixed(2)}, planId=${res.planId}. Next: call prepare_execution with $0 upfront.`,
      resultData: res as unknown as Record<string, unknown>,
    };
  }

  // Natural-language fallback: inspect wallet address or BR R$35k intent if present
  const walletMatch = textInput.match(/0x[a-fA-F0-9]{40}/);
  if (walletMatch) {
    const isBrazil = /\b(brazil|brasil|lei\s*14\.?754|decripto|35k|brl)\b/i.test(textInput);
    const chain = /\bethereum\b/i.test(textInput)
      ? "ethereum"
      : /\barbitrum\b/i.test(textInput)
        ? "arbitrum"
        : "base";
    const res = await executeCheckTaxImpact(
      {
        jurisdiction: isBrazil ? "BR" : "US",
        regime: isBrazil ? "PF_LEI_14754" : "INDIVIDUAL",
        chain,
        walletAddress: walletMatch[0],
        targetAsset: "ETH",
        sellQuantity: 1,
      },
      params.deps
    );
    return {
      skillName: "check_tax_impact",
      summaryText: `Analyzed wallet ${walletMatch[0]} on ${chain} (${isBrazil ? "BR" : "US"}): taxSavedUsd=$${res.taxSavedUsd.toFixed(2)}, planId=${res.planId}. Call prepare_execution with this planId for $0-upfront 1-click calldata.`,
      resultData: res as unknown as Record<string, unknown>,
    };
  }

  if (/\b(35k|35\.000|lei\s*14\.?754|brazil|brasil)\b/i.test(textInput)) {
    const status = executeBr35kStatus({
      monthlySalesBrl: 0,
      plannedSaleUsd: 1000,
      custodyLocation: /\boffshore|dex|binance|foreign\b/i.test(textInput)
        ? "OFFSHORE"
        : "DOMESTIC",
    });
    return {
      skillName: "check_br_35k_status",
      summaryText: `Brazil tax check: status=${status.status}, remainingExemptBrl=R$${status.remainingExemptBrl.toFixed(2)}, recommendedMaxSaleThisMonthUsd=$${status.recommendedMaxSaleThisMonthUsd.toFixed(2)}.`,
      resultData: status as unknown as Record<string, unknown>,
    };
  }

  const card = buildAgentCard(params.deps.env, params.requestUrl);
  return {
    skillName: "capabilities",
    summaryText:
      "TaxRail A2A Agent ready (US IRS 1099-DA/Form 8949 + Brazil Lei 14.754/R$35k/DeCripto, $0-upfront 10%-from-operation 0x v2 & Aave v3 execution). Send a structured JSON DataPart with { skill: 'check_tax_impact' | 'compare_borrow_vs_sell' | 'classify_deductible_expense' | 'prepare_execution' | 'claim_dossier', ... } or include a 0x wallet address in text.",
    resultData: {
      service: "TaxRail",
      a2aProtocol: "JSON-RPC 2.0 & HTTP+JSON (message/send, SendMessage, tasks/get)",
      availableSkills: (card.skills as Array<{ id: string; name: string }>).map((s) => ({
        id: s.id,
        name: s.name,
      })),
      exampleDataPart: {
        skill: "check_tax_impact",
        jurisdiction: "US",
        regime: "INDIVIDUAL",
        chain: "base",
        targetAsset: "ETH",
        sellQuantity: 1,
        walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
      },
    },
  };
}

async function processSendMessage(params: {
  rawParams: unknown;
  isV1: boolean;
  deps: { planStore: PlanStore; env: Env };
  requestUrl: string;
}): Promise<{ ok: true; task: A2aTask } | { ok: false; message: string }> {
  if (!params.rawParams || typeof params.rawParams !== "object" || Array.isArray(params.rawParams)) {
    return { ok: false, message: "Invalid params: expected object containing message" };
  }
  const obj = params.rawParams as Record<string, unknown>;
  const rawMessage = obj.message;
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    return { ok: false, message: "Invalid params: missing message object" };
  }
  const msgObj = rawMessage as Record<string, unknown>;
  if (!Array.isArray(msgObj.parts) || msgObj.parts.length === 0) {
    return { ok: false, message: "Invalid params: message.parts must be a non-empty array" };
  }

  const userMessage: A2aMessage = {
    kind: "message",
    messageId:
      typeof msgObj.messageId === "string" && msgObj.messageId.trim()
        ? msgObj.messageId
        : `msg_${crypto.randomUUID().slice(0, 12)}`,
    role: typeof msgObj.role === "string" ? msgObj.role : params.isV1 ? "ROLE_USER" : "user",
    parts: msgObj.parts as A2aPart[],
  };

  const taskId =
    typeof msgObj.taskId === "string" && msgObj.taskId.trim()
      ? msgObj.taskId
      : `task_${crypto.randomUUID().slice(0, 12)}`;
  const contextId =
    typeof msgObj.contextId === "string" && msgObj.contextId.trim()
      ? msgObj.contextId
      : `ctx_${crypto.randomUUID().slice(0, 12)}`;

  const execution = await runA2aSkillExecution({
    message: userMessage,
    deps: params.deps,
    requestUrl: params.requestUrl,
  });

  const agentMessage: A2aMessage = {
    kind: "message",
    messageId: `msg_${crypto.randomUUID().slice(0, 12)}`,
    role: params.isV1 ? "ROLE_AGENT" : "agent",
    contextId,
    taskId,
    parts: [
      { kind: "text", text: execution.summaryText },
      { kind: "data", data: execution.resultData },
    ],
  };

  const task: A2aTask = {
    id: taskId,
    contextId,
    kind: "task",
    status: {
      state: params.isV1 ? "TASK_STATE_COMPLETED" : "completed",
      timestamp: new Date().toISOString(),
      message: agentMessage,
    },
    artifacts: [
      {
        artifactId: `artifact_${crypto.randomUUID().slice(0, 12)}`,
        name: execution.skillName,
        parts: [
          { kind: "text", text: execution.summaryText },
          { kind: "data", data: execution.resultData },
        ],
      },
    ],
    history: [userMessage, agentMessage],
  };

  await saveA2aTask(params.deps.env, task);
  return { ok: true, task };
}

/**
 * Handles A2A JSON-RPC 2.0 requests (`message/send`, `SendMessage`, `tasks/get`, `GetTask`,
 * `agent/getAuthenticatedExtendedCard`, `GetExtendedAgentCard`) on `POST /`, `POST /a2a`, and `POST /api/a2a`.
 */
export async function handleA2aJsonRpcRequest(
  request: Request,
  deps: { planStore: PlanStore; env: Env }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error: invalid JSON payload");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonRpcError(null, -32600, "Invalid Request: expected JSON-RPC object");
  }

  const rpc = body as Record<string, unknown>;
  const id = rpc.id ?? null;
  const method = typeof rpc.method === "string" ? rpc.method : "";

  if (rpc.jsonrpc !== "2.0" || !method) {
    return jsonRpcError(id, -32600, "Invalid Request: jsonrpc='2.0' and method are required");
  }

  if (method === "message/send" || method === "SendMessage") {
    const isV1 = method === "SendMessage";
    const outcome = await processSendMessage({
      rawParams: rpc.params,
      isV1,
      deps,
      requestUrl: request.url,
    });
    if (!outcome.ok) {
      return jsonRpcError(id, -32602, outcome.message);
    }
    return jsonRpcSuccess(id, isV1 ? { task: outcome.task } : outcome.task);
  }

  if (method === "tasks/get" || method === "GetTask") {
    const paramsObj =
      rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
        ? (rpc.params as Record<string, unknown>)
        : {};
    const taskId =
      typeof paramsObj.id === "string"
        ? paramsObj.id.trim()
        : typeof paramsObj.taskId === "string"
          ? paramsObj.taskId.trim()
          : "";
    if (!taskId) {
      return jsonRpcError(id, -32602, "Invalid params: task id is required");
    }
    const task = await loadA2aTask(deps.env, taskId);
    if (!task) {
      return jsonRpcError(id, -32001, `Task not found: ${taskId}`);
    }
    return jsonRpcSuccess(id, task);
  }

  if (
    method === "agent/getAuthenticatedExtendedCard" ||
    method === "GetExtendedAgentCard"
  ) {
    return jsonRpcSuccess(id, buildAgentCard(deps.env, request.url));
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handles A2A v1.0 HTTP+JSON `POST /message:send`.
 */
export async function handleA2aHttpSendMessage(
  request: Request,
  deps: { planStore: PlanStore; env: Env }
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request body" }, { status: 400 });
  }

  const outcome = await processSendMessage({
    rawParams: body,
    isV1: true,
    deps,
    requestUrl: request.url,
  });

  if (!outcome.ok) {
    return Response.json({ error: outcome.message }, { status: 400 });
  }
  return Response.json({ task: outcome.task }, { status: 200 });
}

/**
 * Handles A2A v1.0 HTTP+JSON `GET /tasks/:id`.
 */
export async function handleA2aHttpGetTask(
  taskId: string,
  deps: { env: Env }
): Promise<Response> {
  const task = await loadA2aTask(deps.env, taskId);
  if (!task) {
    return Response.json({ error: `Task not found: ${taskId}` }, { status: 404 });
  }
  return Response.json(task, { status: 200 });
}
