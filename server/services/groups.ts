// Bot⇄bot DM groups. createGroup / dmGroup for A⇄B visibility.
// — enough to open `Name ⇄ Name` channels. Not rooms, bulletin, or voice.
import { newId } from "../contracts.ts";
import type { Repositories } from "../repositories/index.ts";
import type { TenantMessagesRepository } from "../repositories/messages.ts";
import type { GroupRecord, Message } from "../store.ts";

export type PublicGroup = GroupRecord & { messages: Message[]; hasMore?: boolean };

export type HydrateMessages = { messages?: number };

type MessageReads = Pick<TenantMessagesRepository, "forThread" | "pageForThread">;

function hydrateGroup(messages: MessageReads, group: GroupRecord, hydrate?: HydrateMessages): PublicGroup {
  if (hydrate?.messages === undefined) {
    return { ...group, messages: messages.forThread(group.threadId) };
  }
  const page = messages.pageForThread(group.threadId, { limit: hydrate.messages, slim: true });
  return { ...group, messages: page?.messages ?? [], hasMore: page?.hasMore ?? false };
}

export interface GroupsService {
  /** Authenticated routes must use this owner-bound facade. */
  forOwner(ownerId: string): OwnerGroupsService;
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  byThread(threadId: string): GroupRecord | null;
  dmGroup(a: string, b: string): GroupRecord | null;
  createGroup(name: string, memberIds: string[], dm?: boolean): GroupRecord;
  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "unread">>): GroupRecord | null;
  publicGroup(id: string, hydrate?: HydrateMessages): PublicGroup | null;
  publicGroups(hydrate?: HydrateMessages): PublicGroup[];
}

/** Owner-scoped group API with no desktop-global or repository escape hatch. */
export interface OwnerGroupsService {
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  byThread(threadId: string): GroupRecord | null;
  dmGroup(a: string, b: string): GroupRecord | null;
  createGroup(name: string, memberIds: string[], dm?: boolean): GroupRecord;
  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "unread">>): GroupRecord | null;
  publicGroup(id: string, hydrate?: HydrateMessages): PublicGroup | null;
  publicGroups(hydrate?: HydrateMessages): PublicGroup[];
}

/**
 * Internal desktop-global seam for legacy loopback behavior. Future
 * authenticated routes must call `forOwner(userId)`.
 */
export function createDesktopGlobalGroupsService(opts: { repos: Repositories }): GroupsService {
  const { repos } = opts;
  const service: GroupsService = {
    forOwner: (ownerId) => createOwnerGroupsService(repos, ownerId),
    list: () => repos.groups.list(),
    get: (id) => repos.groups.get(id),
    byThread: (threadId) => repos.groups.getByThread(threadId),
    dmGroup(a, b) {
      return (
        repos.groups.list().find(
          (g) => g.dm === true && g.memberIds.length === 2 && g.memberIds.includes(a) && g.memberIds.includes(b),
        ) ?? null
      );
    },
    createGroup(name, memberIds, dm = false) {
      const group: GroupRecord = {
        id: newId(),
        threadId: newId(),
        name,
        memberIds: [...new Set(memberIds.map((id) => String(id).trim()).filter(Boolean))],
        unread: false,
        createdAt: Date.now(),
        ...(dm ? { dm: true } : {}),
      };
      repos.groups.insert(group);
      return group;
    },
    patchGroup(id, patch) {
      const group = repos.groups.get(id);
      if (!group) return null;
      Object.assign(group, patch);
      if (!repos.groups.update(group)) return null;
      return group;
    },
    publicGroup(id, hydrate) {
      const group = repos.groups.get(id);
      if (!group) return null;
      return hydrateGroup(repos.messages, group, hydrate);
    },
    publicGroups(hydrate) {
      return repos.groups.list().map((group) => hydrateGroup(repos.messages, group, hydrate));
    },
  };
  return service;
}

function createOwnerGroupsService(repos: Repositories, ownerId: string): OwnerGroupsService {
  const groups = repos.groups.forOwner(ownerId);
  const bots = repos.bots.forOwner(ownerId);
  const messages = repos.messages.forOwner(ownerId);

  const ownedMemberIds = (memberIds: string[]): string[] => {
    const normalized = [...new Set(memberIds.map((id) => String(id).trim()).filter(Boolean))];
    for (const botId of normalized) {
      if (!bots.get(botId)) {
        throw Object.assign(new Error("no such group member bot"), { status: 404 });
      }
    }
    return normalized;
  };

  return {
    list: () => groups.list(),
    get: (id) => groups.get(id),
    byThread: (threadId) => groups.getByThread(threadId),
    dmGroup(a, b) {
      return (
        groups.list().find(
          (group) => group.dm === true && group.memberIds.length === 2 && group.memberIds.includes(a) && group.memberIds.includes(b),
        ) ?? null
      );
    },
    createGroup(name, memberIds, dm = false) {
      const group: GroupRecord = {
        id: newId(),
        threadId: newId(),
        name,
        memberIds: ownedMemberIds(memberIds),
        unread: false,
        createdAt: Date.now(),
        ...(dm ? { dm: true } : {}),
      };
      groups.insert(group);
      return group;
    },
    patchGroup(id, patch) {
      const group = groups.get(id);
      if (!group) return null;
      if (patch.name !== undefined) group.name = patch.name;
      if (patch.unread !== undefined) group.unread = patch.unread;
      if (patch.memberIds !== undefined) group.memberIds = ownedMemberIds(patch.memberIds);
      return groups.update(group) ? group : null;
    },
    publicGroup(id, hydrate) {
      const group = groups.get(id);
      return group ? hydrateGroup(messages, group, hydrate) : null;
    },
    publicGroups(hydrate) {
      return groups.list().map((group) => hydrateGroup(messages, group, hydrate));
    },
  };
}

/** Backward-compatible name for existing loopback desktop composition. */
export const createGroupsService = createDesktopGlobalGroupsService;
