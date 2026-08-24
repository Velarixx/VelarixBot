// #118 / #117: event ordering + reconnect must reconstruct terminal
// activity chips, including a later workflow step that must not leave an
// earlier command spinning. Isolated HOME via the harness.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootHarness, connectSse, FAKE_ACP_CLI, type BootedHarness, type SseFrame } from "./testing/harness.ts";

let h: BootedHarness;

const turnDone = (threadId: string) => (f: SseFrame) =>
  f.kind === "runtime" && f.event?.type === "turn.completed" && f.event.threadId === threadId;

type ActivityTool = { name?: string; ok?: boolean; status?: string; command?: string };
type ActivityMessage = { id: string; kind: string; tool?: ActivityTool };

function activitiesOf(bot: { messages?: ActivityMessage[] }): ActivityMessage[] {
  return (bot.messages ?? []).filter((m) => m.kind === "activity");
}

beforeAll(async () => {
  h = await bootHarness({
    instances: {
      grok: {
        driver: "grokAgent",
        environment: { FAKE_ACP_MODE: "activity-lifecycle" },
        config: { cli: FAKE_ACP_CLI, fullAuto: true },
      },
    },
  });
});

afterAll(async () => {
  await h.stop();
});

describe("activity lifecycle across event order and reconnect", () => {
  it("settles stale, cancelled, timed-out, and completed chips and reloads the same terminals", async () => {
    const created = await h.api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await h.api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name: "Lifecycle",
      modelSelection: { instanceId: "grok", model: "fake-model" },
      computer: "off",
    });
    const bot = patched.body.bot as { id: string; threadId: string };

    const live = await connectSse(h.base, h.token);
    await h.api("POST", `/api/bots/${bot.id}/messages`, { text: "run the workflow" });
    await live.until(turnDone(bot.threadId));
    live.close();

    const truth = (await h.api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === bot.id);
    const acts = activitiesOf(truth);
    expect(acts.map((m) => m.tool?.status).sort()).toEqual(["cancelled", "completed", "completed", "timed_out"].sort());
    expect(acts.every((m) => m.tool?.ok !== undefined)).toBe(true);
    expect(acts.some((m) => m.tool?.ok === undefined)).toBe(false);

    const stale = acts.find((m) => m.tool?.command?.includes("example.test"));
    expect(stale?.tool?.status).toBe("completed");
    expect(stale?.tool?.command).toContain("\n--data ok");
    expect(stale?.tool?.command).toContain("[redacted]");
    expect(JSON.stringify(stale?.tool)).not.toContain("sk-live-supersecret");
    expect(acts.find((m) => m.tool?.name === "sleep 30")?.tool?.status).toBe("cancelled");
    expect(acts.find((m) => m.tool?.name === "wait")?.tool?.status).toBe("timed_out");
    expect(acts.find((m) => m.tool?.name === "echo later")?.tool?.status).toBe("completed");

    const snap = await h.api("GET", "/api/events/snapshot");
    const snapBot = snap.body.bots.find((b: { id: string }) => b.id === bot.id);
    const snapActs = activitiesOf(snapBot);
    expect(snapActs.map((m) => ({ id: m.id, status: m.tool?.status, ok: m.tool?.ok }))).toEqual(
      acts.map((m) => ({ id: m.id, status: m.tool?.status, ok: m.tool?.ok })),
    );

    const reloaded = await connectSse(h.base, h.token, { query: snap.body.sequence });
    expect((await reloaded.until((f) => f.kind === "hello")).resumed).toBe(true);
    const replayedPatches = reloaded.frames.filter(
      (f) => f.kind === "message.patch" && f.threadId === bot.threadId && (f.message as ActivityMessage | undefined)?.kind === "activity",
    );
    expect(replayedPatches.every((f) => (f.message as ActivityMessage).tool?.ok !== undefined)).toBe(true);
    reloaded.close();
  });
});
