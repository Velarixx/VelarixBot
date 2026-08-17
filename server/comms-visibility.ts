// Bot⇄bot comms visibility: channel creation, message mirroring, and
// per-thread chips for A⇄B DM visibility.
// so ask_bot and delegate_bot share one A ⇄ B DM path.

import type { BotRecord, GroupRecord, Message } from "./store.ts";

export interface CommsStore {
  bot(id: string): BotRecord | null;
  botByThread(threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message;
  patchMessage(threadId: string, id: string, patch: Partial<Message>): Message | null;
  messagesFor(threadId: string): Message[];
  dmGroup(a: string, b: string): GroupRecord | null;
  createGroup(name: string, memberIds: string[], dm?: boolean): GroupRecord;
  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "unread">>): GroupRecord | null;
}

export interface CommsBus {
  store: CommsStore;
  broadcast: (payload: Record<string, unknown>) => void;
}

export function bindCommsStore(bots: {
  bot(id: string): BotRecord | null;
  botByThread(threadId: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at"> & { at?: number }): Message;
  patchMessage(threadId: string, id: string, patch: Partial<Message>): Message | null;
  messagesFor(threadId: string): Message[];
}, groups: {
  dmGroup(a: string, b: string): GroupRecord | null;
  createGroup(name: string, memberIds: string[], dm?: boolean): GroupRecord;
  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "unread">>): GroupRecord | null;
}): CommsStore {
  return {
    bot: (id) => bots.bot(id),
    botByThread: (threadId) => bots.botByThread(threadId),
    appendMessage: (threadId, message) => bots.appendMessage(threadId, message),
    patchMessage: (threadId, id, patch) => bots.patchMessage(threadId, id, patch),
    messagesFor: (threadId) => bots.messagesFor(threadId),
    dmGroup: (a, b) => groups.dmGroup(a, b),
    createGroup: (name, memberIds, dm) => groups.createGroup(name, memberIds, dm),
    patchGroup: (id, patch) => groups.patchGroup(id, patch),
  };
}

/** Find or create the sidebar DM `Name ⇄ Name` for the pair. */
export function getOrCreateChannel(store: CommsStore, from: BotRecord, target: BotRecord): GroupRecord {
  return store.dmGroup(from.id, target.id) ?? store.createGroup(`${from.name} ⇄ ${target.name}`, [from.id, target.id], true);
}

function note(bus: CommsBus, threadId: string, m: Omit<Message, "id" | "at">): Message {
  const message = bus.store.appendMessage(threadId, m);
  bus.broadcast({ kind: "message", threadId, message });
  return message;
}

/** Mirror the outgoing ask/handoff onto the ⇄ channel and both 1:1 threads. */
export function mirrorExchange(
  bus: CommsBus,
  from: BotRecord,
  target: BotRecord,
  message: string,
  channel: GroupRecord | undefined,
  sourceThreadId = from.threadId,
): void {
  if (channel) {
    note(bus, channel.threadId, {
      role: "bot",
      kind: "text",
      text: message,
      from: { botId: from.id, name: from.name, color: from.color },
    });
  }
  note(bus, sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Messaged @${target.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: target.id, withName: target.name, withColor: target.color }
      : undefined,
  });
  note(bus, target.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Message from @${from.name}` },
    comm: channel
      ? { groupId: channel.id, withBotId: from.id, withName: from.name, withColor: from.color }
      : undefined,
  });
  if (channel) {
    const patched = bus.store.patchGroup(channel.id, { unread: true });
    if (patched) bus.broadcast({ kind: "group", group: patched });
  }
}

/** Mirror the peer's reply onto the ⇄ channel. */
export function mirrorReply(
  bus: CommsBus,
  target: BotRecord,
  reply: string,
  channel: GroupRecord | undefined,
): void {
  if (!channel || !reply.trim()) return;
  note(bus, channel.threadId, {
    role: "bot",
    kind: "text",
    text: reply,
    from: { botId: target.id, name: target.name, color: target.color },
  });
  const patched = bus.store.patchGroup(channel.id, { unread: true });
  if (patched) bus.broadcast({ kind: "group", group: patched });
}
