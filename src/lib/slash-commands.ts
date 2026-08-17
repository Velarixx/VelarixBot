/** Slash-command menu for the composer. Kept small and local — no palette
 * framework. Commands map onto actions this app already has. */

export type SlashAction = "newBot" | "model" | "computer" | "attach" | "stop" | "help";

export interface SlashContext {
  busy: boolean;
}

export interface SlashCommand {
  id: SlashAction;
  name: string;
  description: string;
  /** True when the command can run in this context. */
  enabled: (ctx: SlashContext) => boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "newBot",
    name: "new",
    description: "Start a new bot",
    enabled: () => true,
  },
  {
    id: "model",
    name: "model",
    description: "Change provider or model",
    enabled: () => true,
  },
  {
    id: "computer",
    name: "computer",
    description: "Change computer mode",
    enabled: () => true,
  },
  {
    id: "attach",
    name: "attach",
    description: "Attach files to this message",
    enabled: () => true,
  },
  {
    id: "stop",
    name: "stop",
    description: "Stop the current turn",
    enabled: (ctx) => ctx.busy,
  },
  {
    id: "help",
    name: "help",
    description: "Show available commands",
    enabled: () => true,
  },
];

export interface SlashQuery {
  start: number;
  query: string;
}

/** The active `/` query at the caret. null = not composing a slash command.
 * A second `/` (unix paths like `/Users/foo`) is not a command. */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("/");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("/") || query.includes("\n")) return null;
  return { start: at, query };
}

export interface SlashHit {
  command: SlashCommand;
  enabled: boolean;
}

export function filterSlashCommands(query: string, ctx: SlashContext, catalog = SLASH_COMMANDS): SlashHit[] {
  const q = query.trim().toLowerCase();
  // a trailing space means the token is done — caller should close the menu
  if (query.endsWith(" ")) return [];
  return catalog
    .filter((command) => {
      if (!q) return true;
      return command.name.toLowerCase().includes(q) || command.description.toLowerCase().includes(q);
    })
    .map((command) => ({ command, enabled: command.enabled(ctx) }));
}

export interface SlashSkill {
  id: string;
  name: string;
}

export interface SlashSkillHit {
  skill: SlashSkill;
}

/** This bot's enabled skills in the `/` menu. Pick is this-turn only. */
export function filterSlashSkills(query: string, skills: SlashSkill[]): SlashSkillHit[] {
  const q = query.trim().toLowerCase();
  if (query.endsWith(" ")) return [];
  return skills
    .filter((skill) => {
      if (!q) return true;
      return skill.name.toLowerCase().includes(q);
    })
    .map((skill) => ({ skill }));
}

export type SlashMenuItem =
  | { kind: "command"; hit: SlashHit }
  | { kind: "skill"; hit: SlashSkillHit };

export function slashMenuItems(query: string, ctx: SlashContext, skills: SlashSkill[] = []): SlashMenuItem[] {
  const commands = filterSlashCommands(query, ctx).map((hit) => ({ kind: "command" as const, hit }));
  const skillHits = filterSlashSkills(query, skills).map((hit) => ({ kind: "skill" as const, hit }));
  return [...commands, ...skillHits];
}

export function moveHighlight(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}
