// Turn lifecycle over HTTP: send a message, answer a pending card, interrupt.
import { attachmentPathRefs, expandAttachmentPaths } from "../attachments.ts";
import { newId } from "../contracts.ts";
import type { LaneScheduler } from "../services/lanes.ts";
import type { LineageService } from "../services/lineage.ts";
import type { TurnsService } from "../services/turns.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createTurnsRoutes(deps: { turns: TurnsService; lanes: LaneScheduler; lineage?: LineageService }): RouteHandler {
  const { turns, lanes } = deps;
  return async ({ req, res, path, method }) => {
    let m = path.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const rawText = String(body.text ?? "").trim();
      const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
      const mimeByPath = new Map<string, string | undefined>();
      for (const item of rawAttachments) {
        if (item && typeof item.path === "string" && item.path.trim()) {
          mimeByPath.set(item.path.trim(), typeof item.mime === "string" ? item.mime : undefined);
        }
      }
      const paths = expandAttachmentPaths([...mimeByPath.keys()]);
      const text = attachmentPathRefs(rawText, paths);
      if (!text) {
        json(res, 400, { error: "text required" });
        return true;
      }
      const attachments = paths.map((path) => ({ path, mime: mimeByPath.get(path) }));
      const extraSkillIds = Array.isArray(body.mentionSkillIds)
        ? body.mentionSkillIds.map((id: unknown) => String(id).trim()).filter(Boolean)
        : [];
      const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : undefined;
      const requestId = deps.lineage?.begin({ source: "user", botId: m[1] }).requestId ?? newId();
      const accepted = await lanes.enqueue({
        lane: "user",
        botId: m[1],
        text,
        opts: { attachments, extraSkillIds, requestId },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if (accepted.status === "cancelled") {
        await accepted.settled;
      }
      // [VERIFY] 2026-08-18: existing clients only read `ok`. Extra
      // threadId/messageId let a client correlate the POST with the SSE
      // {kind:"message"} frame without a contract break.
      json(res, 202, {
        ok: true,
        workId: accepted.workId,
        lane: accepted.lane,
        status: accepted.status,
        requestId: accepted.requestId ?? requestId,
        ...(accepted.started ?? {}),
      });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/respond$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      const result = await turns.respond(m[1], String(body.requestId), body);
      if ("error" in result) json(res, result.status, { error: result.error });
      else json(res, 200, result);
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/interrupt$/);
    if (m && method === "POST") {
      const result = await turns.interrupt(m[1]);
      if ("error" in result) json(res, result.status, { error: result.error });
      else json(res, 200, result);
      return true;
    }
    return false;
  };
}
