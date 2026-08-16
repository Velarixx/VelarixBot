// Bot domain service: the product rules that used to live in the Store
// class (creation defaults + onboarding, patch validation, last-bot
// deletion cascade), now over the SQLite repositories.
import { rmSync } from "node:fs";

import {
  avatarPrompt,
  collectAvatarHashes,
  generateAvatarImagesForConfig,
  validBlobHash,
  type AvatarCandidate,
  type AvatarProvider,
  type GenerateAvatarImages,
} from "../avatar-image.ts";
import { seedAvatar, validAvatarNonce } from "../avatar-seed.ts";
import { normalizeComputerBinding } from "../computer/provider.ts";
import { botWorkspaceDir, type AppConfig } from "../config.ts";
import { deleteBlob, readBlob } from "../db/blobs.ts";
import { newId, type ModelSelection } from "../contracts.ts";
import type { Repositories } from "../repositories/index.ts";
import {
  BASE_COMPUTER_BINDINGS,
  STATES,
  onboardingCard,
  resolveIconShape,
  validModelSelection,
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
  generateAvatar(
    id: string,
    opts: { cfg: AppConfig; requested?: string | null; generate?: GenerateAvatarImages },
  ): Promise<{ provider: AvatarProvider; prompt: string; candidates: AvatarCandidate[]; bot: BotRecord }>;
  /** Accepted raster, or a candidate hash this bot still references. */
  readAvatar(id: string, hash?: string | null): { bytes: Buffer; mime: string } | null;
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
      const id = newId();
      // Seeded, not count-rotated: the face is a pure function of the bot's
      // own id + persisted nonce, so it regenerates identically after any
      // reload. Expression stays unpinned at birth — the mascot keeps its
      // live states (busy/unread/profile) until the user re-rolls or picks.
      const face = seedAvatar({ botId: id, nonce: 0 });
      const bot: BotRecord = {
        id,
        threadId: newId(),
        name: "New Bot",
        title: "",
        description: "",
        notifications: true,
        color: face.color,
        iconShape: face.iconShape,
        avatarNonce: 0,
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
      // A patch must never persist a record a later read cannot load — the
      // rc.14 field failure class: one bad field (a non-string name, a
      // string modelSelection) was written straight through, and the bot
      // then vanished from every list()/get() while its row still existed.
      // Reject loudly (400) instead of "succeeding" into silent data loss.
      const invalid = (field: string): never => {
        throw Object.assign(new Error(`invalid bot patch: ${field}`), { status: 400 });
      };
      for (const field of ["name", "title", "description"] as const) {
        if (patch[field] !== undefined && typeof patch[field] !== "string") invalid(field);
      }
      if (patch.modelSelection !== undefined && !validModelSelection(patch.modelSelection)) invalid("modelSelection");
      for (const field of ["alwaysAllow", "requireApproval", "mascotPinned"] as const) {
        if (patch[field] !== undefined && typeof patch[field] !== "boolean") invalid(field);
      }
      const next: Partial<BotRecord> = { ...patch };
      // M1: the pin flag tells the mascot apart from the A1 seed. When the
      // caller doesn't set it explicitly, derive it — a face the user picked
      // pins (clearing it unpins), a face a re-roll derived never pins.
      if (patch.mascotPinned === undefined) {
        if (patch.mascotExpression !== undefined) next.mascotPinned = patch.mascotExpression !== null;
        else if (patch.avatarNonce !== undefined) next.mascotPinned = false;
      }
      // A1 re-roll: a nonce patch re-derives the whole face from the pure
      // seed function, so the persisted record and any future regeneration
      // agree. Explicit color/shape/expression in the same patch win — a
      // manual pick must never be clobbered by a merged re-roll.
      if (patch.avatarNonce !== undefined) {
        if (!validAvatarNonce(patch.avatarNonce)) invalid("avatarNonce");
        const face = seedAvatar({ botId: id, nonce: patch.avatarNonce });
        if (patch.color === undefined) next.color = face.color;
        if (patch.iconShape === undefined) next.iconShape = face.iconShape;
        if (patch.mascotExpression === undefined) next.mascotExpression = face.mascotExpression;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "avatarImageHash")) {
        if (patch.avatarImageHash == null || patch.avatarImageHash === "") {
          delete next.avatarImageHash;
        } else if (!validBlobHash(patch.avatarImageHash)) invalid("avatarImageHash");
      }
      if (Object.prototype.hasOwnProperty.call(patch, "avatarCandidates")) {
        if (patch.avatarCandidates == null) delete next.avatarCandidates;
        else if (!Array.isArray(patch.avatarCandidates) || !patch.avatarCandidates.every(validBlobHash)) {
          invalid("avatarCandidates");
        }
      }
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
      if (Object.prototype.hasOwnProperty.call(patch, "avatarImageHash") && (patch.avatarImageHash == null || patch.avatarImageHash === "")) {
        delete b.avatarImageHash;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "avatarCandidates") && patch.avatarCandidates == null) {
        delete b.avatarCandidates;
      }
      // a write that matched no row must not report success — the caller
      // would broadcast/answer with a record the store does not hold. The
      // bot is gone, so this is a 404 to HTTP callers, never a 500.
      if (!repos.bots.update(b)) {
        throw Object.assign(new Error(`no such bot: ${id} disappeared while patching`), { status: 404 });
      }
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
    async generateAvatar(id, opts) {
      const bot = repos.bots.get(id);
      if (!bot) return Promise.reject(Object.assign(new Error("no such bot"), { status: 404 }));
      const prompt = avatarPrompt(bot);
      const previous = new Set(bot.avatarCandidates ?? []);
      const { provider, candidates } = await generateAvatarImagesForConfig(opts.cfg, {
        prompt,
        requested: opts.requested,
        generate: opts.generate,
      });
      const hashes = candidates.map((c) => c.hash);
      const patched = service.patchBot(id, { avatarCandidates: hashes })!;
      // drop previous candidates this bot (and no one else) no longer names
      const keep = collectAvatarHashes(repos.bots.list());
      for (const hash of previous) {
        if (keep.has(hash)) continue;
        if (repos.messages.blobRefCount(hash) > 0) continue;
        deleteBlob(hash);
      }
      return { provider, prompt, candidates, bot: patched };
    },
    readAvatar(id, hash) {
      const bot = repos.bots.get(id);
      if (!bot) return null;
      const want = hash && validBlobHash(hash) ? hash : bot.avatarImageHash;
      if (!validBlobHash(want)) return null;
      const allowed = new Set<string>([...(bot.avatarCandidates ?? [])]);
      if (validBlobHash(bot.avatarImageHash)) allowed.add(bot.avatarImageHash);
      if (!allowed.has(want)) return null;
      const bytes = readBlob(want);
      if (!bytes) return null;
      return { bytes, mime: "image/png" };
    },
  };
  return service;
}
