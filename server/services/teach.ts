// Teach-a-task service: live bus subscriptions for recording sessions,
// start/stop, and boot-time restore. The persistence stays in teach.ts
// (skills.json / teach-sessions.json — tested module, unchanged).
import type { RuntimeEvent } from "../contracts.ts";
import type { EventBus } from "../harness/bus.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import {
  appendTeachEvent,
  completeTeachSession,
  distillSkill,
  getRecordingSession,
  listTeachSessions,
  saveSkill,
  startPersistedTeachSession,
  type TeachEvent,
  type TeachSessionRecord,
} from "../teach.ts";

export function teachEventFromRuntime(event: RuntimeEvent): TeachEvent {
  const itemType = "itemType" in event ? event.itemType : undefined;
  const title = "title" in event ? event.title : undefined;
  const text = "text" in event ? event.text : undefined;
  const tool = "tool" in event ? event.tool : undefined;
  return {
    type: event.type,
    ...(typeof itemType === "string" ? { itemType } : {}),
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof text === "string" ? { text } : {}),
    ...(typeof tool === "string" ? { tool } : {}),
    createdAt: event.createdAt,
  };
}

export interface TeachService {
  startTeachSession(botId: string): { ok: true; recording: true; session: TeachSessionRecord };
  stopTeachSession(botId: string, name?: string): Promise<{ skill: unknown; session: TeachSessionRecord | null }>;
  restoreTeachSubscriptions(): void;
  /** Bot deletion: drop any live recording subscription. */
  release(botId: string): void;
}

export function createTeachService(deps: {
  bus: EventBus;
  registry: ProviderRegistry;
  bot(id: string): { id: string; threadId: string; modelSelection: { instanceId: string } } | null;
}): TeachService {
  type LiveTeach = { botId: string; threadId: string; unsub: () => void };
  const liveTeach = new Map<string, LiveTeach>();

  function subscribeTeach(botId: string, threadId: string) {
    liveTeach.get(botId)?.unsub();
    const unsub = deps.bus.subscribe((event: RuntimeEvent) => {
      if (event.threadId !== threadId) return;
      appendTeachEvent(botId, teachEventFromRuntime(event));
    });
    liveTeach.set(botId, { botId, threadId, unsub });
  }

  return {
    startTeachSession(botId) {
      const bot = deps.bot(botId);
      if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
      const session = getRecordingSession(botId) ?? startPersistedTeachSession(botId);
      subscribeTeach(botId, bot.threadId);
      return { ok: true, recording: true, session };
    },
    async stopTeachSession(botId, name) {
      const session = getRecordingSession(botId);
      if (!session) throw Object.assign(new Error("no teach session in progress"), { status: 404 });
      liveTeach.get(botId)?.unsub();
      liveTeach.delete(botId);
      const instance = deps.registry.get(deps.bot(botId)?.modelSelection.instanceId ?? "");
      const markdown = await distillSkill({
        name: name?.trim() || "Taught skill",
        events: session.events,
        frames: session.frames,
        generateText: instance?.generateText?.bind(instance),
      });
      const skill = saveSkill({ name: name?.trim() || "Taught skill", botId, markdown });
      const completed = completeTeachSession(botId, { name: name?.trim() || skill.name, skillId: skill.id });
      return { skill, session: completed };
    },
    restoreTeachSubscriptions() {
      for (const session of listTeachSessions()) {
        if (session.status !== "recording") continue;
        const bot = deps.bot(session.botId);
        if (!bot) continue;
        subscribeTeach(bot.id, bot.threadId);
      }
    },
    release(botId) {
      liveTeach.get(botId)?.unsub();
      liveTeach.delete(botId);
    },
  };
}
