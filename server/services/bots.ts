// Bot domain service: the product rules that used to live in the Store
// class (creation defaults + onboarding, patch validation, last-bot
// deletion cascade), now over the SQLite repositories.
import { rmSync } from "node:fs";

import { normalizeComputerBinding } from "../computer/provider.ts";
import { botWorkspaceDir } from "../config.ts";
import { newId, type ModelSelection } from "../contracts.ts";
import type { Repositories } from "../repositories/index.ts";
import {
  BASE_COMPUTER_BINDINGS,
  COLORS,
  ICON_SHAPES,
  STATES,
  onboardingCard,
  resolveIconShape,
  validNotifyEvents,
  validUsage,
  zeroUsage,
  type BotRecord,
  type BotState,
  type Message,
  type Usage,
} from "../store.ts";

export interface BotsService {
  bots(): BotRecord[];
  count(): number;
  bot(id: string): BotRecord | null;
  botByThread(threadId: string): BotRecord | null;
  publicBot(id: string): (BotRecord & { messages: Message[] }) | null;
  createBot(): BotRecord;
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
  /** Repo-level cascade + workspace dir removal. Callers own the runtime
   * teardown (interrupts, pollers, teach subscriptions, memory, skills). */
  deleteBot(id: string): boolean;
  setResumeCursor(id: string, instance: string, cursor: unknown): void;
  recordTurnUsage(id: string, usage: Usage): void;
  clearSkillRefs(skillId: string): void;
  seedIfEmpty(): void;
  messagesFor(threadId: string): Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message;
  patchMessage(threadId: string, id: string, patch: Partial<Message>): Message | null;
}

export function createBotsService(opts: {
  repos: Repositories;
  defaultSelection: () => ModelSelection;
  /** Valid computer bindings besides "off" — the composition root wires the
   * computer registry's provider ids; defaults to the base set. */
  computerBindings?: () => Iterable<string>;
}): BotsService {
  const { repos, defaultSelection } = opts;
  const validComputerBinding = (binding: string): boolean => {
    if (binding === "off") return true;
    for (const id of opts.computerBindings ? opts.computerBindings() : BASE_COMPUTER_BINDINGS) {
      if (id === binding) return true;
    }
    return false;
  };

  const service: BotsService = {
    bots: () => repos.bots.list(),
    count: () => repos.bots.count(),
    bot: (id) => repos.bots.get(id),
    botByThread: (threadId) => repos.bots.getByThread(threadId),
    publicBot(id) {
      const bot = repos.bots.get(id);
      if (!bot) return null;
      return { ...bot, messages: repos.messages.forThread(bot.threadId) };
    },
    createBot() {
      const count = repos.bots.count();
      const bot: BotRecord = {
        id: newId(),
        threadId: newId(),
        name: "New Bot",
        title: "",
        description: "",
        notifications: true,
        color: COLORS[count % COLORS.length],
        iconShape: ICON_SHAPES[count % ICON_SHAPES.length],
        unread: false,
        modelSelection: defaultSelection(),
        resumeCursors: {},
        computer: "off",
        busy: false,
        state: "IDLE",
        usage: zeroUsage(),
        createdAt: Date.now(),
      };
      repos.bots.insert(bot);
      service.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Hey — I'm your new bot. Nice to meet you." });
      service.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
      return bot;
    },
    patchBot(id, patch) {
      const b = repos.bots.get(id);
      if (!b) return null;
      if (patch.state && !STATES.has(patch.state as BotState)) throw new Error("invalid bot state");
      const next: Partial<BotRecord> = { ...patch };
      if (patch.computer !== undefined) {
        const binding = normalizeComputerBinding(patch.computer);
        if (!validComputerBinding(binding)) throw new Error(`invalid computer binding "${binding}"`);
        next.computer = binding;
      }
      if (next.iconShape !== undefined) next.iconShape = resolveIconShape(next.iconShape);
      if (next.notifyEvents !== undefined) {
        const events = validNotifyEvents(next.notifyEvents);
        if (events) next.notifyEvents = events;
        else delete next.notifyEvents;
      }
      if (Object.prototype.hasOwnProperty.call(next, "skillId")) {
        const skillId = typeof next.skillId === "string" ? next.skillId.trim() : "";
        delete next.skillId;
        if (skillId) b.skillId = skillId;
        else delete b.skillId;
      }
      Object.assign(b, next);
      repos.bots.update(b);
      return b;
    },
    deleteBot(id) {
      const b = repos.bots.get(id);
      if (!b) return false;
      repos.deleteBotCascade(id);
      try {
        rmSync(botWorkspaceDir(b.id), { recursive: true, force: true });
      } catch {
        /* workspace dir may be held by a late child on Windows */
      }
      return true;
    },
    setResumeCursor(id, instance, cursor) {
      const b = repos.bots.get(id);
      if (!b) return;
      b.resumeCursors[instance] = cursor;
      repos.bots.update(b);
    },
    recordTurnUsage(id, usage) {
      const b = repos.bots.get(id);
      if (!b) return;
      const u = validUsage(usage);
      b.currentTurnUsage = u;
      b.usage = {
        input: b.usage.input + u.input,
        output: b.usage.output + u.output,
        cost: b.usage.cost === null && u.cost === null ? null : (b.usage.cost ?? 0) + (u.cost ?? 0),
      };
      repos.bots.update(b);
    },
    clearSkillRefs(skillId) {
      for (const bot of repos.bots.list()) {
        if (bot.skillId !== skillId) continue;
        delete bot.skillId;
        repos.bots.update(bot);
      }
      for (const routine of repos.routines.list()) {
        if (routine.skillId !== skillId) continue;
        delete routine.skillId;
        repos.routines.update(routine);
      }
    },
    seedIfEmpty() {
      if (repos.bots.count()) return;
      const b = service.createBot();
      service.patchBot(b.id, { name: "Milind", color: "blue" });
    },
    messagesFor: (threadId) => repos.messages.forThread(threadId),
    appendMessage: (threadId, message) => repos.messages.append(threadId, message),
    patchMessage: (threadId, id, patch) => repos.messages.patch(threadId, id, patch),
  };
  return service;
}
