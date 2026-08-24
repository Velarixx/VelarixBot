// Durable request lineage for P7. One requestId correlates inbound
// (channel / user / routine / agent) → turn → tools → outbound.
// Errors stored here are already redacted and length-bounded by the
// service. Local diagnostics only — not a telemetry pipeline.
import type { SqliteDatabase } from "../db/sqlite-native.ts";

export const LINEAGE_SOURCES = ["user", "channel", "routine", "agent"] as const;
export type LineageSource = (typeof LINEAGE_SOURCES)[number];

export const LINEAGE_STEP_KINDS = ["inbound", "turn", "tool", "outbound", "error"] as const;
export type LineageStepKind = (typeof LINEAGE_STEP_KINDS)[number];

export const LINEAGE_ERROR_MAX = 240;

export interface LineageRow {
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
}

export interface LineageStepRow {
  requestId: string;
  seq: number;
  kind: LineageStepKind;
  ref?: string;
  detail?: string;
  createdAt: number;
}

export interface InsertLineageInput {
  requestId: string;
  source: LineageSource;
  sourceRef?: string;
  botId?: string;
  threadId?: string;
  workId?: string;
  lane?: string;
  createdAt: number;
}

export interface LineagePatch {
  botId?: string;
  threadId?: string;
  turnId?: string;
  workId?: string;
  lane?: string;
  outboundId?: string;
  error?: string;
}

function isSource(value: string): value is LineageSource {
  return (LINEAGE_SOURCES as readonly string[]).includes(value);
}

function isStepKind(value: string): value is LineageStepKind {
  return (LINEAGE_STEP_KINDS as readonly string[]).includes(value);
}

function optionalText(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function toRow(row: {
  request_id: string;
  source: string;
  source_ref: string | null;
  bot_id: string | null;
  thread_id: string | null;
  turn_id: string | null;
  work_id: string | null;
  lane: string | null;
  outbound_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}): LineageRow | null {
  if (!isSource(row.source)) return null;
  return {
    requestId: row.request_id,
    source: row.source,
    ...(optionalText(row.source_ref) ? { sourceRef: row.source_ref! } : {}),
    ...(optionalText(row.bot_id) ? { botId: row.bot_id! } : {}),
    ...(optionalText(row.thread_id) ? { threadId: row.thread_id! } : {}),
    ...(optionalText(row.turn_id) ? { turnId: row.turn_id! } : {}),
    ...(optionalText(row.work_id) ? { workId: row.work_id! } : {}),
    ...(optionalText(row.lane) ? { lane: row.lane! } : {}),
    ...(optionalText(row.outbound_id) ? { outboundId: row.outbound_id! } : {}),
    ...(optionalText(row.error) ? { error: row.error! } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStep(row: {
  request_id: string;
  seq: number;
  kind: string;
  ref: string | null;
  detail: string | null;
  created_at: number;
}): LineageStepRow | null {
  if (!isStepKind(row.kind)) return null;
  return {
    requestId: row.request_id,
    seq: row.seq,
    kind: row.kind,
    ...(optionalText(row.ref) ? { ref: row.ref! } : {}),
    ...(optionalText(row.detail) ? { detail: row.detail! } : {}),
    createdAt: row.created_at,
  };
}

export interface LineageRepository {
  insert(input: InsertLineageInput): LineageRow;
  get(requestId: string): LineageRow | null;
  getBySourceRef(source: LineageSource, sourceRef: string): LineageRow | null;
  latestForThread(threadId: string): LineageRow | null;
  patch(requestId: string, patch: LineagePatch, updatedAt: number): boolean;
  addStep(input: { requestId: string; kind: LineageStepKind; ref?: string; detail?: string; createdAt: number }): LineageStepRow | null;
  steps(requestId: string): LineageStepRow[];
}

export function createLineageRepository(db: SqliteDatabase): LineageRepository {
  const select = db.prepare<{
    request_id: string;
    source: string;
    source_ref: string | null;
    bot_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    work_id: string | null;
    lane: string | null;
    outbound_id: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT request_id, source, source_ref, bot_id, thread_id, turn_id, work_id, lane, outbound_id, error, created_at, updated_at
     FROM request_lineage WHERE request_id = ?`,
  );
  const selectSource = db.prepare<{
    request_id: string;
    source: string;
    source_ref: string | null;
    bot_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    work_id: string | null;
    lane: string | null;
    outbound_id: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT request_id, source, source_ref, bot_id, thread_id, turn_id, work_id, lane, outbound_id, error, created_at, updated_at
     FROM request_lineage WHERE source = ? AND source_ref = ? ORDER BY created_at DESC, request_id DESC LIMIT 1`,
  );
  const selectThread = db.prepare<{
    request_id: string;
    source: string;
    source_ref: string | null;
    bot_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    work_id: string | null;
    lane: string | null;
    outbound_id: string | null;
    error: string | null;
    created_at: number;
    updated_at: number;
  }>(
    `SELECT request_id, source, source_ref, bot_id, thread_id, turn_id, work_id, lane, outbound_id, error, created_at, updated_at
     FROM request_lineage WHERE thread_id = ? ORDER BY updated_at DESC, request_id DESC LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT INTO request_lineage(request_id, source, source_ref, bot_id, thread_id, work_id, lane, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE request_lineage SET
       bot_id = COALESCE(?, bot_id),
       thread_id = COALESCE(?, thread_id),
       turn_id = COALESCE(?, turn_id),
       work_id = COALESCE(?, work_id),
       lane = COALESCE(?, lane),
       outbound_id = COALESCE(?, outbound_id),
       error = COALESCE(?, error),
       updated_at = ?
     WHERE request_id = ?`,
  );
  const nextSeq = db.prepare<{ seq: number | null }>(
    "SELECT MAX(seq) AS seq FROM request_lineage_steps WHERE request_id = ?",
  );
  const insertStep = db.prepare(
    "INSERT INTO request_lineage_steps(request_id, seq, kind, ref, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const selectSteps = db.prepare<{
    request_id: string;
    seq: number;
    kind: string;
    ref: string | null;
    detail: string | null;
    created_at: number;
  }>(
    "SELECT request_id, seq, kind, ref, detail, created_at FROM request_lineage_steps WHERE request_id = ? ORDER BY seq",
  );

  return {
    insert(input) {
      insert.run(
        input.requestId,
        input.source,
        input.sourceRef ?? null,
        input.botId ?? null,
        input.threadId ?? null,
        input.workId ?? null,
        input.lane ?? null,
        input.createdAt,
        input.createdAt,
      );
      const row = toRow(select.get(input.requestId)!);
      if (!row) throw new Error("request lineage insert failed");
      return row;
    },
    get(requestId) {
      const raw = select.get(String(requestId ?? "").trim());
      return raw ? toRow(raw) : null;
    },
    getBySourceRef(source, sourceRef) {
      const ref = String(sourceRef ?? "").trim();
      if (!ref) return null;
      const raw = selectSource.get(source, ref);
      return raw ? toRow(raw) : null;
    },
    latestForThread(threadId) {
      const id = String(threadId ?? "").trim();
      if (!id) return null;
      const raw = selectThread.get(id);
      return raw ? toRow(raw) : null;
    },
    patch(requestId, patch, updatedAt) {
      return (
        update.run(
          patch.botId ?? null,
          patch.threadId ?? null,
          patch.turnId ?? null,
          patch.workId ?? null,
          patch.lane ?? null,
          patch.outboundId ?? null,
          patch.error ?? null,
          updatedAt,
          String(requestId ?? "").trim(),
        ).changes > 0
      );
    },
    addStep(input) {
      const requestId = String(input.requestId ?? "").trim();
      if (!requestId || !select.get(requestId)) return null;
      const seq = (nextSeq.get(requestId)?.seq ?? 0) + 1;
      insertStep.run(requestId, seq, input.kind, input.ref ?? null, input.detail ?? null, input.createdAt);
      return {
        requestId,
        seq,
        kind: input.kind,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.detail ? { detail: input.detail } : {}),
        createdAt: input.createdAt,
      };
    },
    steps(requestId) {
      return selectSteps
        .all(String(requestId ?? "").trim())
        .map(toStep)
        .filter((row): row is LineageStepRow => row !== null);
    },
  };
}
