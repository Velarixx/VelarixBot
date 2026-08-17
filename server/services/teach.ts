// Teach-a-task service: live bus subscriptions for recording sessions,
// start/stop (draft distill), confirm-save (library + enable), and
// boot-time restore. Persistence stays in teach.ts (skills.json /
// teach-sessions.json). Stop never writes a SkillRecord.
import type { RuntimeEvent } from "../contracts.ts";
import type { EventBus } from "../harness/bus.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { fleetGenerateText } from "../memory.ts";
import { enabledSkillIds, uniqueSkillIds } from "../store.ts";
import {
  appendTeachEvent,
  appendTeachFrame,
  completeTeachSession,
  confirmTeachSession,
  discardTeachDraft,
  distillSkill,
  distillSkillMarkdown,
  getRecordingSession,
  getTeachDraftSession,
  listTeachSessions,
  saveSkill,
  startPersistedTeachSession,
  type SkillRecord,
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

export type TeachBot = {
  id: string;
  threadId: string;
  modelSelection: { instanceId: string };
  enabledSkills?: string[];
  skillId?: string;
};

export interface TeachService {
  startTeachSession(botId: string): { ok: true; recording: true; session: TeachSessionRecord };
  stopTeachSession(
    botId: string,
    name?: string,
  ): Promise<{ markdown: string; name: string; session: TeachSessionRecord | null; recording: false }>;
  saveTeachSession(
    botId: string,
    opts?: { name?: string; markdown?: string; sessionId?: string },
  ): { skill: SkillRecord; session: TeachSessionRecord | null; bot: TeachBot };
  discardTeachSession(botId: string, sessionId?: string): { ok: true; session: TeachSessionRecord | null };
  /** Count a timestamp-only frame from the existing screenshot stream. */
  noteFrame(botId: string): TeachSessionRecord | null;
  restoreTeachSubscriptions(): void;
  /** Bot deletion: drop any live recording subscription. */
  release(botId: string): void;
}

export function createTeachService(deps: {
  bus: EventBus;
  registry: ProviderRegistry;
  bot(id: string): TeachBot | null;
  patchBot(id: string, patch: { enabledSkills: string[] }): TeachBot | null;
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

  function requireBot(botId: string): TeachBot {
    const bot = deps.bot(botId);
    if (!bot) throw Object.assign(new Error("no such bot"), { status: 404 });
    return bot;
  }

  return {
    startTeachSession(botId) {
      const bot = requireBot(botId);
      const session = getRecordingSession(botId) ?? startPersistedTeachSession(botId);
      subscribeTeach(botId, bot.threadId);
      return { ok: true, recording: true, session };
    },
    async stopTeachSession(botId, name) {
      const session = getRecordingSession(botId);
      if (!session) throw Object.assign(new Error("no teach session in progress"), { status: 404 });
      liveTeach.get(botId)?.unsub();
      liveTeach.delete(botId);
      const bot = deps.bot(botId);
      const skillName = name?.trim() || "Taught skill";
      const generateText = fleetGenerateText(deps.registry.instances(), bot?.modelSelection.instanceId);
      let markdown: string;
      try {
        markdown = await distillSkill({
          name: skillName,
          events: session.events,
          frames: session.frames,
          generateText,
        });
      } catch {
        markdown = distillSkillMarkdown({ name: skillName, events: session.events, frames: session.frames });
      }
      const completed = completeTeachSession(botId, { name: skillName, draftMarkdown: markdown });
      return { markdown, name: skillName, session: completed, recording: false };
    },
    saveTeachSession(botId, opts = {}) {
      const bot = requireBot(botId);
      const session = (opts.sessionId ? listTeachSessions(botId).find((s) => s.id === opts.sessionId) : null) ?? getTeachDraftSession(botId);
      if (!session || session.status !== "completed" || session.skillId) {
        throw Object.assign(new Error("no teach draft to save"), { status: 404 });
      }
      const skillName = opts.name?.trim() || session.name || "Taught skill";
      const markdown = (opts.markdown ?? session.draftMarkdown ?? "").trim();
      if (!markdown) throw Object.assign(new Error("name and markdown required"), { status: 400 });
      const skill = saveSkill({ name: skillName, botId, markdown });
      const patched = deps.patchBot(botId, { enabledSkills: uniqueSkillIds([...enabledSkillIds(bot), skill.id]) });
      if (!patched) throw Object.assign(new Error("no such bot"), { status: 404 });
      const confirmed = confirmTeachSession(session.id, { skillId: skill.id, name: skill.name });
      return { skill, session: confirmed, bot: patched };
    },
    discardTeachSession(botId, sessionId) {
      requireBot(botId);
      const session = (sessionId ? listTeachSessions(botId).find((s) => s.id === sessionId) : null) ?? getTeachDraftSession(botId);
      if (!session || session.skillId) {
        throw Object.assign(new Error("no teach draft to discard"), { status: 404 });
      }
      return { ok: true, session: discardTeachDraft(session.id) };
    },
    noteFrame(botId) {
      return appendTeachFrame(botId);
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
