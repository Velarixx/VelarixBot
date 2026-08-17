// Bot⇄bot DM groups. Slim port of OpenMausBot store.createGroup / dmGroup
// — enough to open `Name ⇄ Name` channels. Not rooms, bulletin, or voice.
import { newId } from "../contracts.ts";
import type { Repositories } from "../repositories/index.ts";
import type { GroupRecord, Message } from "../store.ts";

export type PublicGroup = GroupRecord & { messages: Message[]; hasMore?: boolean };

export type HydrateMessages = { messages?: number };

function hydrateGroup(repos: Repositories, group: GroupRecord, hydrate?: HydrateMessages): PublicGroup {
  if (hydrate?.messages === undefined) {
    return { ...group, messages: repos.messages.forThread(group.threadId) };
  }
  const page = repos.messages.pageForThread(group.threadId, { limit: hydrate.messages, slim: true });
  return { ...group, messages: page?.messages ?? [], hasMore: page?.hasMore ?? false };
}

export interface GroupsService {
  list(): GroupRecord[];
  get(id: string): GroupRecord | null;
  byThread(threadId: string): GroupRecord | null;
  dmGroup(a: string, b: string): GroupRecord | null;
  createGroup(name: string, memberIds: string[], dm?: boolean): GroupRecord;
  patchGroup(id: string, patch: Partial<Pick<GroupRecord, "name" | "memberIds" | "unread">>): GroupRecord | null;
  publicGroup(id: string, hydrate?: HydrateMessages): PublicGroup | null;
  publicGroups(hydrate?: HydrateMessages): PublicGroup[];
}

export function createGroupsService(opts: { repos: Repositories }): GroupsService {
  const { repos } = opts;
  const service: GroupsService = {
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
      return hydrateGroup(repos, group, hydrate);
    },
    publicGroups(hydrate) {
      return repos.groups.list().map((group) => hydrateGroup(repos, group, hydrate));
    },
  };
  return service;
}
