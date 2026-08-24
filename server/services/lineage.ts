// P7 request lineage — one id from inbound through turn, tools, and
// outbound. Layers on the existing bus / startTurn / channel events.
// Errors are redacted and length-bounded before they touch SQLite.
// Local diagnostics only: no remote sink, no Sentry, no product analytics.
import { newId } from "../contracts.ts";
import { redactSecrets } from "../redact-text.ts";
import {
  LINEAGE_ERROR_MAX,
  LINEAGE_SOURCES,
  type LineageRepository,
  type LineageRow,
  type LineageSource,
  type LineageStepKind,
  type LineageStepRow,
} from "../repositories/lineage.ts";

export { LINEAGE_ERROR_MAX, LINEAGE_SOURCES, type LineageSource };

export interface LineageBeginInput {
  requestId?: string;
  source: LineageSource;
  sourceRef?: string;
  botId?: string;
  threadId?: string;
  workId?: string;
  lane?: string;
}

export interface LineageBeginResult {
  requestId: string;
  created: boolean;
}

export interface PublicLineageStep {
  seq: number;
  kind: LineageStepKind;
  ref?: string;
  detail?: string;
  createdAt: number;
}

/** Counts-and-ids only. Never secrets, tokens, or raw provider payloads. */
export interface PublicLineage {
  requestId: string;
  source: LineageSource;
  sourceRef?: string;
  botId?: string;
  threadId?: string;
  turnId?: string;
  workId?: string;
  lane?: string;
  outboundId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  steps: PublicLineageStep[];
}

export interface LineageService {
  begin(input: LineageBeginInput): LineageBeginResult;
  bindThread(threadId: string, requestId: string): void;
  forThread(threadId: string): string | undefined;
  noteTurn(requestId: string, turnId: string): void;
  noteTool(requestId: string, itemId?: string, title?: string): void;
  noteOutbound(requestId: string, outboundId: string): void;
  noteError(requestId: string, error: string): void;
  get(requestId: string): LineageRow | null;
  publicView(requestId: string): PublicLineage | null;
}

const PUBLIC_LINEAGE_KEYS = [
  "requestId",
  "source",
  "sourceRef",
  "botId",
  "threadId",
  "turnId",
  "workId",
  "lane",
  "outboundId",
  "error",
  "createdAt",
  "updatedAt",
  "steps",
] as const;

const PUBLIC_STEP_KEYS = ["seq", "kind", "ref", "detail", "createdAt"] as const;

export function boundRedactedText(raw: string, max = LINEAGE_ERROR_MAX): string {
  const cleaned = redactSecrets(String(raw ?? "")).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function optionalBound(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = boundRedactedText(raw);
  return cleaned || undefined;
}

export function createLineageService(deps: {
  store: LineageRepository;
  now?: () => number;
}): LineageService {
  const now = deps.now ?? (() => Date.now());
  const threadIds = new Map<string, string>();

  function rememberThread(threadId: string | undefined, requestId: string): void {
    const id = String(threadId ?? "").trim();
    if (id) threadIds.set(id, requestId);
  }

  function publicSteps(requestId: string): PublicLineageStep[] {
    return deps.store.steps(requestId).map((step) => ({
      seq: step.seq,
      kind: step.kind,
      ...(step.ref ? { ref: step.ref } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
      createdAt: step.createdAt,
    }));
  }

  function toPublic(row: LineageRow): PublicLineage {
    return {
      requestId: row.requestId,
      source: row.source,
      ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
      ...(row.botId ? { botId: row.botId } : {}),
      ...(row.threadId ? { threadId: row.threadId } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.workId ? { workId: row.workId } : {}),
      ...(row.lane ? { lane: row.lane } : {}),
      ...(row.outboundId ? { outboundId: row.outboundId } : {}),
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      steps: publicSteps(row.requestId),
    };
  }

  return {
    begin(input) {
      const sourceRef = typeof input.sourceRef === "string" && input.sourceRef.trim() ? input.sourceRef.trim() : undefined;
      const provided = typeof input.requestId === "string" && input.requestId.trim() ? input.requestId.trim() : "";
      if (provided) {
        const existing = deps.store.get(provided);
        if (existing) {
          deps.store.patch(
            existing.requestId,
            {
              ...(input.botId ? { botId: input.botId } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.workId ? { workId: input.workId } : {}),
              ...(input.lane ? { lane: input.lane } : {}),
            },
            now(),
          );
          rememberThread(input.threadId ?? existing.threadId, existing.requestId);
          return { requestId: existing.requestId, created: false };
        }
      }
      if (sourceRef) {
        const existing = deps.store.getBySourceRef(input.source, sourceRef);
        if (existing) {
          deps.store.patch(
            existing.requestId,
            {
              ...(input.botId ? { botId: input.botId } : {}),
              ...(input.threadId ? { threadId: input.threadId } : {}),
              ...(input.workId ? { workId: input.workId } : {}),
              ...(input.lane ? { lane: input.lane } : {}),
            },
            now(),
          );
          rememberThread(input.threadId ?? existing.threadId, existing.requestId);
          return { requestId: existing.requestId, created: false };
        }
      }
      const requestId = provided || newId();
      const createdAt = now();
      const row = deps.store.insert({
        requestId,
        source: input.source,
        ...(sourceRef ? { sourceRef } : {}),
        ...(input.botId ? { botId: input.botId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.workId ? { workId: input.workId } : {}),
        ...(input.lane ? { lane: input.lane } : {}),
        createdAt,
      });
      if (input.source === "channel" || input.source === "user" || input.source === "routine" || input.source === "agent") {
        deps.store.addStep({
          requestId: row.requestId,
          kind: "inbound",
          ref: sourceRef,
          detail: input.source,
          createdAt,
        });
      }
      rememberThread(input.threadId, row.requestId);
      return { requestId: row.requestId, created: true };
    },
    bindThread(threadId, requestId) {
      const id = String(requestId ?? "").trim();
      const thread = String(threadId ?? "").trim();
      if (!id || !thread) return;
      threadIds.set(thread, id);
      deps.store.patch(id, { threadId: thread }, now());
    },
    forThread(threadId) {
      const thread = String(threadId ?? "").trim();
      if (!thread) return undefined;
      return threadIds.get(thread) ?? deps.store.latestForThread(thread)?.requestId;
    },
    noteTurn(requestId, turnId) {
      const id = String(requestId ?? "").trim();
      const turn = String(turnId ?? "").trim();
      if (!id || !turn) return;
      const at = now();
      deps.store.patch(id, { turnId: turn }, at);
      deps.store.addStep({ requestId: id, kind: "turn", ref: turn, createdAt: at });
    },
    noteTool(requestId, itemId, title) {
      const id = String(requestId ?? "").trim();
      if (!id) return;
      const at = now();
      deps.store.addStep({
        requestId: id,
        kind: "tool",
        ref: optionalBound(itemId),
        detail: optionalBound(title),
        createdAt: at,
      });
    },
    noteOutbound(requestId, outboundId) {
      const id = String(requestId ?? "").trim();
      const outbound = String(outboundId ?? "").trim();
      if (!id || !outbound) return;
      const at = now();
      deps.store.patch(id, { outboundId: outbound }, at);
      deps.store.addStep({ requestId: id, kind: "outbound", ref: outbound, createdAt: at });
    },
    noteError(requestId, error) {
      const id = String(requestId ?? "").trim();
      const safe = boundRedactedText(error);
      if (!id || !safe) return;
      const at = now();
      deps.store.patch(id, { error: safe }, at);
      deps.store.addStep({ requestId: id, kind: "error", detail: safe, createdAt: at });
    },
    get(requestId) {
      return deps.store.get(String(requestId ?? "").trim());
    },
    publicView(requestId) {
      const row = deps.store.get(String(requestId ?? "").trim());
      return row ? toPublic(row) : null;
    },
  };
}

export function publicLineageFieldNames(): readonly string[] {
  return PUBLIC_LINEAGE_KEYS;
}

export function publicStepFieldNames(): readonly string[] {
  return PUBLIC_STEP_KEYS;
}

export type { LineageRow, LineageStepRow };
