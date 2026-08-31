import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureAgentTasks,
  createAgentTask,
  createMemoryAgentTasksStore,
  agentTasks,
} from "../agent-tasks.ts";
import { createAgentTaskRoutes } from "./agent-tasks.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function ctxFor(method: string, path: string, body?: unknown) {
  const state = { status: 0, body: null as Record<string, unknown> | null };
  const res = {
    writeHead(code: number) {
      state.status = code;
      return res;
    },
    end(data?: string) {
      state.body = data ? JSON.parse(data) : null;
    },
  } as unknown as ServerResponse;
  const req = (body !== undefined ? Readable.from([JSON.stringify(body)]) : Readable.from([])) as unknown as IncomingMessage;
  return { ctx: { req, res, url: new URL(`http://x${path}`), path, method }, state };
}

describe("assigned-task user archival route", () => {
  beforeEach(() => {
    configureAgentTasks(createMemoryAgentTasksStore());
  });

  afterEach(() => {
    configureAgentTasks(null);
  });

  it("cancels and archives through patchAgentTask without deleting the row", async () => {
    const task = createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "chief",
      fromName: "Chief",
      sourceThreadId: "lead-thread",
      assignment: "research this",
      now: 10,
    });
    const broadcasted: unknown[] = [];
    const routes = createAgentTaskRoutes({
      broadcast: (event) => broadcasted.push(event),
      now: () => 20,
    });

    const cancel = ctxFor("PATCH", `/api/agent-tasks/${task.id}`, { state: "cancelled", reason: "Cancelled" });
    expect(await routes(cancel.ctx)).toBe(true);
    expect(cancel.state.status).toBe(200);
    expect(cancel.state.body).toMatchObject({ task: { id: task.id, state: "cancelled", reason: "Cancelled" } });
    expect(agentTasks().get(task.id)?.state).toBe("cancelled");
    expect(agentTasks().list()).toHaveLength(1);
    expect(broadcasted).toEqual([expect.objectContaining({ kind: "task", task: expect.objectContaining({ state: "cancelled" }) })]);

    const other = createAgentTask({
      assigneeBotId: "helper",
      fromBotId: "other",
      fromName: "Other",
      sourceThreadId: "other-thread",
      assignment: "follow up",
      now: 30,
    });
    const dismiss = ctxFor("PATCH", `/api/agent-tasks/${other.id}`, { state: "stale", reason: "Dismissed" });
    expect(await routes(dismiss.ctx)).toBe(true);
    expect(agentTasks().get(other.id)).toMatchObject({ state: "stale", reason: "Dismissed", assignment: "follow up" });
    expect(agentTasks().list()).toHaveLength(2);
  });

  it("rejects non-terminal user states and does not delete messages", async () => {
    const src = readFileSync(join(HERE, "agent-tasks.ts"), "utf8");
    expect(src).not.toMatch(/deleteForBot|interrupt\(/);
    const routes = createAgentTaskRoutes({ now: () => 1 });
    const denied = ctxFor("PATCH", "/api/agent-tasks/missing", { state: "completed" });
    expect(await routes(denied.ctx)).toBe(true);
    expect(denied.state.status).toBe(400);
    const missing = ctxFor("PATCH", "/api/agent-tasks/missing", { state: "stale" });
    expect(await routes(missing.ctx)).toBe(true);
    expect(missing.state.status).toBe(404);
  });
});
