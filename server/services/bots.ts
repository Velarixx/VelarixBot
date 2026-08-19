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
import type { TenantMessagesRepository } from "../repositories/messages.ts";
import { normalizeBotColor } from "../engine-setup.ts";
import {
  BASE_COMPUTER_BINDINGS,
  STATES,
  onboardingCard,
  resolveIconShape,
  validModelSelection,
  enabledSkillIds,
  uniqueSkillIds,
  validNotifyEvents,
  validUsage,
  zeroUsage,
  type BotRecord,
  type BotState,
  type Message,
  type Usage,
} from "../store.ts";

/** Wire-safe bot: allowlist of BotRecord fields plus transcript. Never
 * resumeCursors (session tokens) or any other non-public field. */
export type PublicBot = Omit<BotRecord, "resumeCursors"> & { messages: Message[]; hasMore?: boolean };

/** `messages` omitted = full transcript (desktop back-compat). Present =
 * newest n, slim screens, and `hasMore`. */
export type HydrateMessages = { messages?: number };

/** Field-by-field allowlist. A denylist would leak the next private field. */
export function toPublicBot(bot: BotRecord, messages: Message[] = []): PublicBot {
  const pub: PublicBot = {
    id: bot.id,
    threadId: bot.threadId,
    name: bot.name,
    title: bot.title,
    description: bot.description,
    notifications: bot.notifications,
    color: bot.color,
    unread: bot.unread,
    modelSelection: bot.modelSelection,
    computer: bot.computer,
    busy: bot.busy,
    state: bot.state,
    usage: bot.usage,
    createdAt: bot.createdAt,
    messages,
  };
  if (bot.mascotExpression !== undefined) pub.mascotExpression = bot.mascotExpression;
  if (bot.iconShape !== undefined) pub.iconShape = bot.iconShape;
  if (bot.mascotPinned !== undefined) pub.mascotPinned = bot.mascotPinned;
  if (bot.avatarNonce !== undefined) pub.avatarNonce = bot.avatarNonce;
  if (bot.avatarImageHash !== undefined) pub.avatarImageHash = bot.avatarImageHash;
  if (bot.avatarCandidates !== undefined) pub.avatarCandidates = bot.avatarCandidates;
  if (bot.pinned !== undefined) pub.pinned = bot.pinned;
  if (bot.hidden !== undefined) pub.hidden = bot.hidden;
  if (bot.stateDetail !== undefined) pub.stateDetail = bot.stateDetail;
  if (bot.stateCode !== undefined) pub.stateCode = bot.stateCode;
  if (bot.currentTurnUsage !== undefined) pub.currentTurnUsage = bot.currentTurnUsage;
  if (bot.requireApproval !== undefined) pub.requireApproval = bot.requireApproval;
  if (bot.alwaysAllow !== undefined) pub.alwaysAllow = bot.alwaysAllow;
  if (bot.enabledApps !== undefined) pub.enabledApps = bot.enabledApps;
  if (bot.enabledSkills !== undefined) pub.enabledSkills = bot.enabledSkills;
  if (bot.skillId !== undefined) pub.skillId = bot.skillId;
  if (bot.notifyEvents !== undefined) pub.notifyEvents = bot.notifyEvents;
  if (bot.threadParticipants !== undefined) pub.threadParticipants = bot.threadParticipants;
  return pub;
}

type MessageReads = Pick<TenantMessagesRepository, "forThread" | "pageForThread">;

function hydrateBot(messages: MessageReads, bot: BotRecord, hydrate?: HydrateMessages): PublicBot {
  if (hydrate?.messages === undefined) return toPublicBot(bot, messages.forThread(bot.threadId));
  const page = messages.pageForThread(bot.threadId, { limit: hydrate.messages, slim: true });
  // no `before` cursor — pageForThread cannot miss
  return { ...toPublicBot(bot, page?.messages ?? []), hasMore: page?.hasMore ?? false };
}

/** Project a {kind:"bot"} SSE/API payload through the allowlist. */
export function projectPublicBotFrame(
  payload: unknown,
  publicOf: (id: string) => PublicBot | null,
): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const frame = payload as { kind?: unknown; bot?: { id?: unknown } };
  if (frame.kind !== "bot" || !frame.bot || typeof frame.bot !== "object") return payload;
  const id = frame.bot.id;
  if (typeof id === "string") {
    const pub = publicOf(id);
    if (pub) return { ...frame, bot: pub };
  }
  return { ...frame, bot: toPublicBot(frame.bot as BotRecord) };
}

export interface BotsService {
  /** Authenticated routes must use this owner-bound facade. */
  forOwner(ownerId: string): OwnerBotsService;
  bots(): BotRecord[];
  count(): number;
  bot(id: string): BotRecord | null;
  botByThread(threadId: string): BotRecord | null;
  publicBot(id: string, hydrate?: HydrateMessages): PublicBot | null;
  publicBots(hydrate?: HydrateMessages): PublicBot[];
  /** Scrollback: the page before a message the client already holds. */
  pageMessages(threadId: string, opts: { limit: number; before?: string | null }):
    | { ok: true; messages: Message[]; hasMore: boolean }
    | { ok: false; status: 404; error: string };
  readMessageImage(threadId: string, messageId: string):
    | { ok: true; bytes: Buffer; mime: string }
    | { ok: false; status: 404; error: string };
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

/**
 * Owner-scoped application API. Process-wide maintenance, recovery, resume
 * cursors, usage accounting, and raw repositories are deliberately absent.
 */
export interface OwnerBotsService {
  bots(): BotRecord[];
  count(): number;
  bot(id: string): BotRecord | null;
  botByThread(threadId: string): BotRecord | null;
  publicBot(id: string, hydrate?: HydrateMessages): PublicBot | null;
  publicBots(hydrate?: HydrateMessages): PublicBot[];
  pageMessages(threadId: string, opts: { limit: number; before?: string | null }):
    | { ok: true; messages: Message[]; hasMore: boolean }
    | { ok: false; status: 404; error: string };
  readMessageImage(threadId: string, messageId: string):
    | { ok: true; bytes: Buffer; mime: string }
    | { ok: false; status: 404; error: string };
  createBot(): BotRecord;
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
  deleteBot(id: string): boolean;
  messagesFor(threadId: string): Message[];
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message;
  patchMessage(threadId: string, id: string, patch: Partial<Message>): Message | null;
  generateAvatar(
    id: string,
    opts: { cfg: AppConfig; requested?: string | null; generate?: GenerateAvatarImages },
  ): Promise<{ provider: AvatarProvider; prompt: string; candidates: AvatarCandidate[]; bot: BotRecord }>;
  readAvatar(id: string, hash?: string | null): { bytes: Buffer; mime: string } | null;
}

export interface BotsServiceOptions {
  repos: Repositories;
  defaultSelection: () => ModelSelection;
  /** Valid computer bindings besides "off" — the composition root wires the
   * computer registry's provider ids; defaults to the base set. */
  computerBindings?: () => Iterable<string>;
}

/**
 * Internal desktop-global seam. It intentionally includes legacy-unowned and
 * tenant-owned rows for loopback desktop behavior and process-wide recovery.
 * Future authenticated routes must call `forOwner(userId)` on this service.
 */
export function createDesktopGlobalBotsService(opts: BotsServiceOptions): BotsService {
  const { repos, defaultSelection } = opts;
  const validComputerBinding = (binding: string): boolean => {
    if (binding === "off") return true;
    for (const id of opts.computerBindings ? opts.computerBindings() : BASE_COMPUTER_BINDINGS) {
      if (id === binding) return true;
    }
    return false;
  };

  const service: BotsService = {
    forOwner: (ownerId) => createOwnerBotsService(opts, ownerId),
    bots: () => repos.bots.list(),
    count: () => repos.bots.count(),
    bot: (id) => repos.bots.get(id),
    botByThread: (threadId) => repos.bots.getByThread(threadId),
    publicBot(id, hydrate) {
      const bot = repos.bots.get(id);
      if (!bot) return null;
      return hydrateBot(repos.messages, bot, hydrate);
    },
    publicBots(hydrate) {
      return repos.bots.list().map((bot) => hydrateBot(repos.messages, bot, hydrate));
    },
    pageMessages(threadId, opts) {
      if (!repos.bots.getByThread(threadId) && !repos.groups.getByThread(threadId)) {
        return { ok: false, status: 404, error: "no such conversation" };
      }
      const page = repos.messages.pageForThread(threadId, { ...opts, slim: true });
      if (!page) return { ok: false, status: 404, error: "no such message" };
      return { ok: true, ...page };
    },
    readMessageImage(threadId, messageId) {
      if (!repos.bots.getByThread(threadId) && !repos.groups.getByThread(threadId)) {
        return { ok: false, status: 404, error: "no such conversation" };
      }
      const image = repos.messages.readImage(threadId, messageId);
      if (!image) return { ok: false, status: 404, error: "no image on that message" };
      return { ok: true, ...image };
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
      // [VERIFY] 2026-08-18: whitespace-only names used to persist and
      // render as blank sidebar rows. Reject (400) rather than silently
      // rewrite to "New Bot" — a PATCH the user sent must not invent a name.
      if (typeof patch.name === "string") {
        const name = patch.name.trim();
        if (!name) invalid("name");
        patch = { ...patch, name };
      }
      if (patch.color !== undefined) {
        const color = normalizeBotColor(patch.color);
        if (!color) invalid("color");
        else patch = { ...patch, color };
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
      if (Object.prototype.hasOwnProperty.call(next, "enabledSkills")) {
        const ids = uniqueSkillIds(Array.isArray(next.enabledSkills) ? next.enabledSkills.map(String) : []);
        delete next.enabledSkills;
        b.enabledSkills = ids;
        if (ids.length) b.skillId = ids[0];
        else delete b.skillId;
      } else if (Object.prototype.hasOwnProperty.call(next, "skillId")) {
        const skillId = typeof next.skillId === "string" ? next.skillId.trim() : "";
        delete next.skillId;
        const hasSet = (b.enabledSkills?.length ?? 0) > 0;
        if (!hasSet) {
          if (skillId) {
            b.enabledSkills = [skillId];
            b.skillId = skillId;
          } else {
            delete b.skillId;
            delete b.enabledSkills;
          }
        } else if (skillId) {
          b.enabledSkills = uniqueSkillIds([...enabledSkillIds(b), skillId]);
          b.skillId = skillId;
        } else {
          delete b.skillId;
        }
      }
      Object.assign(b, next);
      if (Object.prototype.hasOwnProperty.call(patch, "stateDetail") && patch.stateDetail === undefined) {
        delete b.stateDetail;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "stateCode") && !patch.stateCode) {
        delete b.stateCode;
      } else if (b.state !== "BLOCKED") {
        delete b.stateCode;
      }
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
        const current = enabledSkillIds(bot);
        if (!current.includes(skillId) && bot.skillId !== skillId) continue;
        const nextIds = current.filter((id) => id !== skillId);
        bot.enabledSkills = nextIds;
        if (bot.skillId === skillId) {
          if (nextIds.length) bot.skillId = nextIds[0];
          else delete bot.skillId;
        }
        repos.bots.update(bot);
      }
      for (const routine of repos.routines.list()) {
        if (routine.skillId !== skillId) continue;
        delete routine.skillId;
        repos.routines.update(routine);
      }
    },
    seedIfEmpty() {
      // Empty workspace only. Never rename an existing row — a user who
      // created "Milind" (or anything else) keeps that name forever.
      // [VERIFY] 2026-08-18: product copy and tests already treat
      // "Chief of Staff" as the on-brand seed (rc14-field, index MCP
      // update_bot). Do not migrate historical names.
      if (repos.bots.count()) return;
      const b = service.createBot();
      service.patchBot(b.id, { name: "Chief of Staff", color: "blue" });
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

function createOwnerBotsService(
  opts: BotsServiceOptions,
  ownerId: string,
): OwnerBotsService {
  const { repos, defaultSelection } = opts;
  const bots = repos.bots.forOwner(ownerId);
  const messages = repos.messages.forOwner(ownerId);
  const groups = repos.groups.forOwner(ownerId);
  // Reuse the desktop validation policy through an internal adapter whose bot
  // reads/writes are the owner repository. The adapter itself is never
  // returned, so its global maintenance surface cannot escape this facade.
  const validatedMutations = createDesktopGlobalBotsService({
    ...opts,
    repos: {
      ...repos,
      bots: {
        ...repos.bots,
        list: () => bots.list(),
        get: (id) => bots.get(id),
        getByThread: (threadId) => bots.getByThread(threadId),
        count: () => bots.count(),
        insert: (bot) => bots.insert(bot),
        update: (bot) => bots.update(bot),
      },
    },
  });

  const ownsConversation = (threadId: string): boolean =>
    bots.getByThread(threadId) !== null || groups.getByThread(threadId) !== null;

  const service: OwnerBotsService = {
    bots: () => bots.list(),
    count: () => bots.count(),
    bot: (id) => bots.get(id),
    botByThread: (threadId) => bots.getByThread(threadId),
    publicBot(id, hydrate) {
      const bot = bots.get(id);
      return bot ? hydrateBot(messages, bot, hydrate) : null;
    },
    publicBots(hydrate) {
      return bots.list().map((bot) => hydrateBot(messages, bot, hydrate));
    },
    pageMessages(threadId, pageOpts) {
      if (!ownsConversation(threadId)) {
        return { ok: false, status: 404, error: "no such conversation" };
      }
      const page = messages.pageForThread(threadId, { ...pageOpts, slim: true });
      if (!page) return { ok: false, status: 404, error: "no such message" };
      return { ok: true, ...page };
    },
    readMessageImage(threadId, messageId) {
      if (!ownsConversation(threadId)) {
        return { ok: false, status: 404, error: "no such conversation" };
      }
      const image = messages.readImage(threadId, messageId);
      if (!image) return { ok: false, status: 404, error: "no image on that message" };
      return { ok: true, ...image };
    },
    createBot() {
      const id = newId();
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
      bots.insert(bot);
      messages.append(bot.threadId, { role: "bot", kind: "text", text: "Hey — I'm your new bot. Nice to meet you." });
      messages.append(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() });
      return bot;
    },
    patchBot(id, patch) {
      return validatedMutations.patchBot(id, patch);
    },
    deleteBot(id) {
      const bot = bots.get(id);
      if (!bot) return false;
      // Repositories currently expose cascade deletion only at the internal
      // seam. The owner lookup above makes foreign/legacy ids absent before
      // this synchronous process-wide maintenance operation can run.
      const deleted = repos.deleteBotCascade(bot.id);
      if (!deleted) return false;
      try {
        rmSync(botWorkspaceDir(bot.id), { recursive: true, force: true });
      } catch {
        /* workspace dir may be held by a late child on Windows */
      }
      return true;
    },
    messagesFor: (threadId) => messages.forThread(threadId),
    appendMessage: (threadId, message) => messages.append(threadId, message),
    patchMessage: (threadId, id, patch) => messages.patch(threadId, id, patch),
    async generateAvatar(id, avatarOpts) {
      const bot = bots.get(id);
      if (!bot) return Promise.reject(Object.assign(new Error("no such bot"), { status: 404 }));
      const prompt = avatarPrompt(bot);
      const previous = new Set(bot.avatarCandidates ?? []);
      const { provider, candidates } = await generateAvatarImagesForConfig(avatarOpts.cfg, {
        prompt,
        requested: avatarOpts.requested,
        generate: avatarOpts.generate,
      });
      // Re-authorize after awaiting the provider. A bot deleted while images
      // were generated must not turn into an unscoped update.
      const patched = service.patchBot(id, { avatarCandidates: candidates.map((candidate) => candidate.hash) });
      if (!patched) throw Object.assign(new Error("no such bot"), { status: 404 });
      // Blob GC is process-wide bookkeeping: scan all references so one
      // tenant can never delete another tenant's content-addressed avatar.
      // No cross-tenant record is returned through the owner facade.
      const keep = collectAvatarHashes(repos.bots.list());
      for (const hash of previous) {
        if (keep.has(hash) || repos.messages.blobRefCount(hash) > 0) continue;
        deleteBlob(hash);
      }
      return { provider, prompt, candidates, bot: patched };
    },
    readAvatar(id, hash) {
      const bot = bots.get(id);
      if (!bot) return null;
      const want = hash && validBlobHash(hash) ? hash : bot.avatarImageHash;
      if (!validBlobHash(want)) return null;
      const allowed = new Set<string>(bot.avatarCandidates ?? []);
      if (validBlobHash(bot.avatarImageHash)) allowed.add(bot.avatarImageHash);
      if (!allowed.has(want)) return null;
      const bytes = readBlob(want);
      return bytes ? { bytes, mime: "image/png" } : null;
    },
  };
  return service;
}

/** Backward-compatible name for existing loopback desktop composition. */
export const createBotsService = createDesktopGlobalBotsService;
