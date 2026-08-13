import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { botWorkspaceDir, DATA_DIR } from "./config.ts";
import { newId, type ModelSelection, type ThreadId } from "./contracts.ts";

export type MausColor = "green" | "blue" | "red" | "orange" | "purple" | "cyan" | "pink" | "yellow" | "teal" | "coral";
export type MausExpression = string;
export const ICON_SHAPES = ["cursor", "blob", "circle", "squircle", "diamond", "hexagon", "teardrop", "shield"] as const;
export type IconShape = (typeof ICON_SHAPES)[number];
export function resolveIconShape(value: unknown): IconShape {
  return ICON_SHAPES.includes(value as IconShape) ? (value as IconShape) : "cursor";
}
export type BotState = "IDLE" | "RUNNING" | "DONE" | "BLOCKED" | "NEEDS_INPUT";
export interface Usage { input: number; output: number; cost: number | null }
export interface OptionCardData { title: string; subtitle: string; options: string[]; answered?: string; dismissed?: boolean; requestId?: string; requestType?: "permission" | "question" | "credential" }
export interface Message {
  id: string; role: "bot" | "user"; kind: "text" | "options" | "activity" | "screen"; text?: string;
  card?: OptionCardData; tool?: { name: string; ok?: boolean }; png?: string; mime?: string; at: number; usage?: Usage;
}
export interface BotRecord {
  id: string; threadId: ThreadId; name: string; title: string; description: string; notifications: boolean; color: MausColor;
  mascotExpression?: MausExpression | null; iconShape?: IconShape; unread: boolean; modelSelection: ModelSelection; resumeCursors: Record<string, unknown>;
  computer: "cloud" | "local" | "off"; pinned?: boolean; hidden?: boolean; busy: boolean; state: BotState; stateDetail?: string;
  usage: Usage; currentTurnUsage?: Usage; createdAt: number; requireApproval?: boolean;
  /** Connected-app slugs this bot may use (Composio). Empty/missing = none. */
  enabledApps?: string[];
  /** Taught skill attached to every turn this bot runs. */
  skillId?: string;
  /** Per-event notification overrides. Missing keys default on when `notifications` is on. */
  notifyEvents?: Partial<Record<"request.opened" | "turn.completed" | "stall.nudge" | "peer.reply", boolean>>;
  /** Bots sharing this thread's transcript (group mention / ask_bot). */
  threadParticipants?: string[];
}
export type RoutineSchedule = { kind: "interval"; everyMinutes: number } | { kind: "daily"; time: string };
export interface ThenStartTurn { botId: string; prompt: string }
export interface RoutineRecord {
  id: string; botId: string; name: string; prompt: string; schedule: RoutineSchedule; enabled: boolean; running: boolean;
  nextRunAt: number; lastRunAt: number | null; lastResult: string | null; createdAt: number;
  thenStartTurn?: ThenStartTurn;
  skillId?: string;
}

const BOTS_FILE = join(DATA_DIR, "bots.json");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const messagesFile = (id: string) => join(DATA_DIR, `messages-${id}.json`);
const COLORS: MausColor[] = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
const STATES = new Set<BotState>(["IDLE", "RUNNING", "DONE", "BLOCKED", "NEEDS_INPUT"]);
const MODES = new Set(["cloud", "local", "off"]);
const zeroUsage = (): Usage => ({ input: 0, output: 0, cost: null });

function atomicWrite(path: string, value: unknown, preserveCurrent = true) {
  mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  if (preserveCurrent && existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temp, path);
}
function readArray(path: string): unknown[] {
  try { const v: unknown = JSON.parse(readFileSync(path, "utf8")); if (!Array.isArray(v)) throw new Error("not array"); return v; }
  catch {
    try { const v: unknown = JSON.parse(readFileSync(`${path}.bak`, "utf8")); if (!Array.isArray(v)) throw new Error("not array"); atomicWrite(path, v, false); return v; }
    catch { return []; }
  }
}
function validUsage(v: unknown): Usage {
  const x = v as Partial<Usage> | null;
  return { input: Number.isFinite(x?.input) ? Math.max(0, Number(x!.input)) : 0, output: Number.isFinite(x?.output) ? Math.max(0, Number(x!.output)) : 0, cost: Number.isFinite(x?.cost) ? Math.max(0, Number(x!.cost)) : null };
}
function migrateBot(v: unknown): BotRecord | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Partial<BotRecord>;
  if (![b.id, b.threadId, b.name].every((x) => typeof x === "string") || !b.modelSelection || typeof b.modelSelection.instanceId !== "string" || typeof b.modelSelection.model !== "string") return null;
  const crashed = b.state === "RUNNING" || b.busy === true;
  return {
    id: b.id!, threadId: b.threadId!, name: b.name!, title: typeof b.title === "string" ? b.title : "", description: typeof b.description === "string" ? b.description : "",
    notifications: b.notifications !== false, color: COLORS.includes(b.color as MausColor) ? b.color! : "blue", mascotExpression: b.mascotExpression,
    iconShape: resolveIconShape(b.iconShape),
    unread: b.unread === true, modelSelection: b.modelSelection, resumeCursors: b.resumeCursors && typeof b.resumeCursors === "object" ? b.resumeCursors : {},
    computer: MODES.has(String(b.computer)) ? b.computer! : "off", pinned: b.pinned, hidden: b.hidden, busy: false,
    state: crashed ? "BLOCKED" : STATES.has(b.state as BotState) ? b.state! : "IDLE", ...(crashed ? { stateDetail: "interrupted" } : b.stateDetail ? { stateDetail: b.stateDetail } : {}),
    usage: validUsage(b.usage), currentTurnUsage: b.currentTurnUsage ? validUsage(b.currentTurnUsage) : undefined, createdAt: Number.isFinite(b.createdAt) ? b.createdAt! : Date.now(),
    ...(b.requireApproval === true ? { requireApproval: true } : {}),
    ...(validStringList(b.enabledApps) ? { enabledApps: validStringList(b.enabledApps) } : {}),
    ...(typeof b.skillId === "string" && b.skillId.trim() ? { skillId: b.skillId.trim() } : {}),
    ...(validNotifyEvents(b.notifyEvents) ? { notifyEvents: validNotifyEvents(b.notifyEvents) } : {}),
    ...(validStringList(b.threadParticipants) ? { threadParticipants: validStringList(b.threadParticipants) } : {}),
  };
}
export function nextRunAt(schedule: RoutineSchedule, from = Date.now()): number {
  if (schedule.kind === "interval") {
    if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes <= 0) throw new Error("invalid interval");
    return from + schedule.everyMinutes * 60_000;
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("invalid daily time");
  const [h, m] = schedule.time.split(":").map(Number); const d = new Date(from); d.setHours(h, m, 0, 0); if (d.getTime() <= from) d.setDate(d.getDate() + 1); return d.getTime();
}
const NOTIFY_EVENT_KEYS = new Set(["request.opened", "turn.completed", "stall.nudge", "peer.reply"]);
function validNotifyEvents(v: unknown): BotRecord["notifyEvents"] | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: NonNullable<BotRecord["notifyEvents"]> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (!NOTIFY_EVENT_KEYS.has(key) || typeof val !== "boolean") continue;
    out[key as keyof NonNullable<BotRecord["notifyEvents"]>] = val;
  }
  return Object.keys(out).length ? out : undefined;
}
function validStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => String(x).trim()).filter(Boolean);
  return out;
}
function validThenStartTurn(v: unknown): ThenStartTurn | undefined {
  if (!v || typeof v !== "object") return undefined;
  const t = v as Partial<ThenStartTurn>;
  if (typeof t.botId !== "string" || !t.botId.trim()) return undefined;
  if (typeof t.prompt !== "string" || !t.prompt.trim()) return undefined;
  return { botId: t.botId.trim(), prompt: t.prompt.trim() };
}
function migrateRoutine(v: unknown): RoutineRecord | null {
  if (!v || typeof v !== "object") return null; const r = v as Partial<RoutineRecord>;
  if (![r.id, r.botId, r.name, r.prompt].every((x) => typeof x === "string") || !r.schedule) return null;
  try {
    const next = Number.isFinite(r.nextRunAt) ? r.nextRunAt! : nextRunAt(r.schedule);
    const thenStartTurn = validThenStartTurn(r.thenStartTurn);
    return {
      id: r.id!, botId: r.botId!, name: r.name!, prompt: r.prompt!, schedule: r.schedule, enabled: r.enabled !== false,
      running: false, nextRunAt: next, lastRunAt: Number.isFinite(r.lastRunAt) ? r.lastRunAt! : null,
      lastResult: typeof r.lastResult === "string" ? r.lastResult : null,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt! : Date.now(),
      ...(thenStartTurn ? { thenStartTurn } : {}),
      ...(typeof r.skillId === "string" && r.skillId.trim() ? { skillId: r.skillId.trim() } : {}),
    };
  } catch { return null; }
}

export function mentionedBots<T extends { name: string; hidden?: boolean }>(text: string, peers: T[]): T[] {
  const candidates=peers.filter(p=>!p.hidden&&p.name.trim()).sort((a,b)=>b.name.length-a.name.length), lower=text.toLowerCase(), found:T[]=[]; let at=-1;
  while((at=lower.indexOf("@",at+1))!==-1){if(at>0&&!/\s/.test(text[at-1]))continue;const hit=candidates.find(p=>lower.slice(at+1).startsWith(p.name.toLowerCase()));if(hit&&!found.includes(hit))found.push(hit);} return found;
}
const onboardingCard=():OptionCardData=>({title:"What do you mostly want help with?",subtitle:"Pick whatever's closest; we can always expand from there.",options:["Work & projects","Writing & research","Life admin","A bit of everything"]});

export class Store {
  bots: BotRecord[];
  routines: RoutineRecord[];
  /** Wired by the harness to SSE `{kind:"routine"}` / `routine.deleted`. */
  onRoutine?: (routine: RoutineRecord) => void;
  onRoutineDeleted?: (routineId: string) => void;
  private messages = new Map<string, Message[]>();
  private defaultSelection: () => ModelSelection;

  constructor(defaultSelection: () => ModelSelection) {
    this.defaultSelection = defaultSelection;
    mkdirSync(DATA_DIR, { recursive: true });
    this.bots = readArray(BOTS_FILE).map(migrateBot).filter((b): b is BotRecord => !!b);
    this.routines = readArray(ROUTINES_FILE).map(migrateRoutine).filter((r): r is RoutineRecord => !!r);
    if (this.bots.length) atomicWrite(BOTS_FILE, this.bots);
    if (this.routines.length) atomicWrite(ROUTINES_FILE, this.routines);
  }
  private saveBots(){atomicWrite(BOTS_FILE,this.bots)} private saveRoutines(){atomicWrite(ROUTINES_FILE,this.routines)}
  messagesFor(threadId:string):Message[]{let list=this.messages.get(threadId);if(!list){list=readArray(messagesFile(threadId)).filter((m):m is Message=>!!m&&typeof m==="object"&&typeof (m as Message).id==="string");this.messages.set(threadId,list);}return list;}
  private saveMessages(id:string){atomicWrite(messagesFile(id),this.messagesFor(id))}
  appendMessage(threadId:string,message:Omit<Message,"id"|"at">&{at?:number}):Message{const full={id:newId(),at:Date.now(),...message};this.messagesFor(threadId).push(full);this.saveMessages(threadId);return full;}
  patchMessage(threadId:string,id:string,patch:Partial<Message>):Message|null{const list=this.messagesFor(threadId),i=list.findIndex(m=>m.id===id);if(i<0)return null;list[i]={...list[i],...patch,card:patch.card??list[i].card};this.saveMessages(threadId);return list[i];}
  bot(id:string){return this.bots.find(b=>b.id===id)??null} botByThread(id:string){return this.bots.find(b=>b.threadId===id)??null}
  createBot():BotRecord{const bot:BotRecord={id:newId(),threadId:newId(),name:"New Bot",title:"",description:"",notifications:true,color:COLORS[this.bots.length%COLORS.length],iconShape:ICON_SHAPES[this.bots.length%ICON_SHAPES.length],unread:false,modelSelection:this.defaultSelection(),resumeCursors:{},computer:"off",busy:false,state:"IDLE",usage:zeroUsage(),createdAt:Date.now()};this.bots.unshift(bot);this.saveBots();this.appendMessage(bot.threadId,{role:"bot",kind:"text",text:"Hey — I'm your new bot. Nice to meet you."});this.appendMessage(bot.threadId,{role:"bot",kind:"options",card:onboardingCard()});return bot;}
  deleteBot(id:string){const b=this.bot(id);if(!b)return false;this.bots=this.bots.filter(x=>x.id!==id);this.routines=this.routines.filter(r=>r.botId!==id);this.saveBots();this.saveRoutines();this.messages.delete(b.threadId);try{unlinkSync(messagesFile(b.threadId))}catch{}try{unlinkSync(`${messagesFile(b.threadId)}.bak`)}catch{}try{rmSync(botWorkspaceDir(b.id),{recursive:true,force:true})}catch{}return true;}
  patchBot(id:string,patch:Partial<BotRecord>){
    const b=this.bot(id);if(!b)return null;if(patch.computer&&!MODES.has(patch.computer))throw new Error("invalid computer mode");if(patch.state&&!STATES.has(patch.state))throw new Error("invalid bot state");
    const next: Partial<BotRecord> = { ...patch };
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
    Object.assign(b,next);this.saveBots();return b;
  }
  clearSkillRefs(skillId:string){
    for (const bot of this.bots) {
      if (bot.skillId === skillId) delete bot.skillId;
    }
    let routinesChanged = false;
    for (const routine of this.routines) {
      if (routine.skillId === skillId) {
        delete routine.skillId;
        routinesChanged = true;
      }
    }
    this.saveBots();
    if (routinesChanged) this.saveRoutines();
  }
  setResumeCursor(id:string,instance:string,cursor:unknown){const b=this.bot(id);if(b){b.resumeCursors[instance]=cursor;this.saveBots();}}
  recordTurnUsage(id:string,usage:Usage){const b=this.bot(id);if(!b)return;const u=validUsage(usage);b.currentTurnUsage=u;b.usage={input:b.usage.input+u.input,output:b.usage.output+u.output,cost:b.usage.cost===null&&u.cost===null?null:(b.usage.cost??0)+(u.cost??0)};this.saveBots();}
  seedIfEmpty(){if(this.bots.length)return;const b=this.createBot();this.patchBot(b.id,{name:"Milind",color:"blue"});}
  routine(id:string){return this.routines.find(r=>r.id===id)??null}
  createRoutine(input:{botId:string;name:string;prompt:string;schedule:RoutineSchedule;thenStartTurn?:ThenStartTurn;skillId?:string}){if(!this.bot(input.botId))throw new Error("no such bot");if(!input.name.trim()||!input.prompt.trim())throw new Error("name and prompt required");const thenStartTurn=validThenStartTurn(input.thenStartTurn);const skillId=typeof input.skillId==="string"&&input.skillId.trim()?input.skillId.trim():undefined;const r:RoutineRecord={id:newId(),botId:input.botId,name:input.name.trim(),prompt:input.prompt.trim(),schedule:input.schedule,enabled:true,running:false,nextRunAt:nextRunAt(input.schedule),lastRunAt:null,lastResult:null,createdAt:Date.now(),...(thenStartTurn?{thenStartTurn}:{}),...(skillId?{skillId}:{})};this.routines.push(r);this.saveRoutines();return r;}
  patchRoutine(id:string,patch:Pick<Partial<RoutineRecord>,"name"|"prompt"|"schedule"|"enabled"|"thenStartTurn"|"skillId">){
    const r=this.routine(id);if(!r)return null;
    const safe: Pick<Partial<RoutineRecord>,"name"|"prompt"|"schedule"|"enabled"|"thenStartTurn"|"skillId"> = {};
    if (patch.name !== undefined) { if (!patch.name.trim()) throw new Error("name required"); safe.name = patch.name.trim(); }
    if (patch.prompt !== undefined) { if (!patch.prompt.trim()) throw new Error("prompt required"); safe.prompt = patch.prompt.trim(); }
    if (patch.schedule !== undefined) { safe.schedule = patch.schedule; r.nextRunAt = nextRunAt(patch.schedule); }
    if (patch.enabled !== undefined) safe.enabled = patch.enabled === true;
    Object.assign(r,safe);
    if (patch.thenStartTurn !== undefined) {
      const thenStartTurn = validThenStartTurn(patch.thenStartTurn);
      if (thenStartTurn) r.thenStartTurn = thenStartTurn;
      else delete r.thenStartTurn;
    }
    if (patch.skillId !== undefined) {
      const skillId = typeof patch.skillId === "string" ? patch.skillId.trim() : "";
      if (skillId) r.skillId = skillId;
      else delete r.skillId;
    }
    this.saveRoutines();return r;
  }
  markRoutine(id:string,patch:Pick<Partial<RoutineRecord>,"running"|"nextRunAt"|"lastRunAt"|"lastResult">){const r=this.routine(id);if(!r)return null;Object.assign(r,patch);this.saveRoutines();this.onRoutine?.(r);return r;}
  deleteRoutine(id:string){if(!this.routine(id))return false;this.routines=this.routines.filter(r=>r.id!==id);this.saveRoutines();this.onRoutineDeleted?.(id);return true;}
}
