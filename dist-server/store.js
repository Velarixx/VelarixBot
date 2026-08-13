import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { newId } from "./contracts.js";
const BOTS_FILE = join(DATA_DIR, "bots.json");
const ROUTINES_FILE = join(DATA_DIR, "routines.json");
const messagesFile = (id) => join(DATA_DIR, `messages-${id}.json`);
const COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"];
const STATES = new Set(["IDLE", "RUNNING", "DONE", "BLOCKED", "NEEDS_INPUT"]);
const MODES = new Set(["cloud", "local", "off"]);
const zeroUsage = () => ({ input: 0, output: 0, cost: null });
function atomicWrite(path, value, preserveCurrent = true) {
    mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2));
    if (preserveCurrent && existsSync(path))
        copyFileSync(path, `${path}.bak`);
    renameSync(temp, path);
}
function readArray(path) {
    try {
        const v = JSON.parse(readFileSync(path, "utf8"));
        if (!Array.isArray(v))
            throw new Error("not array");
        return v;
    }
    catch {
        try {
            const v = JSON.parse(readFileSync(`${path}.bak`, "utf8"));
            if (!Array.isArray(v))
                throw new Error("not array");
            atomicWrite(path, v, false);
            return v;
        }
        catch {
            return [];
        }
    }
}
function validUsage(v) {
    const x = v;
    return { input: Number.isFinite(x?.input) ? Math.max(0, Number(x.input)) : 0, output: Number.isFinite(x?.output) ? Math.max(0, Number(x.output)) : 0, cost: Number.isFinite(x?.cost) ? Math.max(0, Number(x.cost)) : null };
}
function migrateBot(v) {
    if (!v || typeof v !== "object")
        return null;
    const b = v;
    if (![b.id, b.threadId, b.name].every((x) => typeof x === "string") || !b.modelSelection || typeof b.modelSelection.instanceId !== "string" || typeof b.modelSelection.model !== "string")
        return null;
    const crashed = b.state === "RUNNING" || b.busy === true;
    return {
        id: b.id, threadId: b.threadId, name: b.name, title: typeof b.title === "string" ? b.title : "", description: typeof b.description === "string" ? b.description : "",
        notifications: b.notifications !== false, color: COLORS.includes(b.color) ? b.color : "blue", mascotExpression: b.mascotExpression,
        unread: b.unread === true, modelSelection: b.modelSelection, resumeCursors: b.resumeCursors && typeof b.resumeCursors === "object" ? b.resumeCursors : {},
        computer: MODES.has(String(b.computer)) ? b.computer : "off", pinned: b.pinned, hidden: b.hidden, busy: false,
        state: crashed ? "BLOCKED" : STATES.has(b.state) ? b.state : "IDLE", ...(crashed ? { stateDetail: "interrupted" } : b.stateDetail ? { stateDetail: b.stateDetail } : {}),
        usage: validUsage(b.usage), currentTurnUsage: b.currentTurnUsage ? validUsage(b.currentTurnUsage) : undefined, createdAt: Number.isFinite(b.createdAt) ? b.createdAt : Date.now(),
    };
}
export function nextRunAt(schedule, from = Date.now()) {
    if (schedule.kind === "interval") {
        if (!Number.isFinite(schedule.everyMinutes) || schedule.everyMinutes <= 0)
            throw new Error("invalid interval");
        return from + schedule.everyMinutes * 60_000;
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time))
        throw new Error("invalid daily time");
    const [h, m] = schedule.time.split(":").map(Number);
    const d = new Date(from);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= from)
        d.setDate(d.getDate() + 1);
    return d.getTime();
}
function migrateRoutine(v) {
    if (!v || typeof v !== "object")
        return null;
    const r = v;
    if (![r.id, r.botId, r.name, r.prompt].every((x) => typeof x === "string") || !r.schedule)
        return null;
    try {
        const next = Number.isFinite(r.nextRunAt) ? r.nextRunAt : nextRunAt(r.schedule);
        return { id: r.id, botId: r.botId, name: r.name, prompt: r.prompt, schedule: r.schedule, enabled: r.enabled !== false, running: false, nextRunAt: next, lastRunAt: Number.isFinite(r.lastRunAt) ? r.lastRunAt : null, lastResult: typeof r.lastResult === "string" ? r.lastResult : null, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now() };
    }
    catch {
        return null;
    }
}
export function mentionedBots(text, peers) {
    const candidates = peers.filter(p => !p.hidden && p.name.trim()).sort((a, b) => b.name.length - a.name.length), lower = text.toLowerCase(), found = [];
    let at = -1;
    while ((at = lower.indexOf("@", at + 1)) !== -1) {
        if (at > 0 && !/\s/.test(text[at - 1]))
            continue;
        const hit = candidates.find(p => lower.slice(at + 1).startsWith(p.name.toLowerCase()));
        if (hit && !found.includes(hit))
            found.push(hit);
    }
    return found;
}
const onboardingCard = () => ({ title: "What do you mostly want help with?", subtitle: "Pick whatever's closest; we can always expand from there.", options: ["Work & projects", "Writing & research", "Life admin", "A bit of everything"] });
export class Store {
    bots;
    routines;
    messages = new Map();
    defaultSelection;
    constructor(defaultSelection) {
        this.defaultSelection = defaultSelection;
        mkdirSync(DATA_DIR, { recursive: true });
        this.bots = readArray(BOTS_FILE).map(migrateBot).filter((b) => !!b);
        this.routines = readArray(ROUTINES_FILE).map(migrateRoutine).filter((r) => !!r);
        if (this.bots.length)
            atomicWrite(BOTS_FILE, this.bots);
        if (this.routines.length)
            atomicWrite(ROUTINES_FILE, this.routines);
    }
    saveBots() { atomicWrite(BOTS_FILE, this.bots); }
    saveRoutines() { atomicWrite(ROUTINES_FILE, this.routines); }
    messagesFor(threadId) { let list = this.messages.get(threadId); if (!list) {
        list = readArray(messagesFile(threadId)).filter((m) => !!m && typeof m === "object" && typeof m.id === "string");
        this.messages.set(threadId, list);
    } return list; }
    saveMessages(id) { atomicWrite(messagesFile(id), this.messagesFor(id)); }
    appendMessage(threadId, message) { const full = { id: newId(), at: Date.now(), ...message }; this.messagesFor(threadId).push(full); this.saveMessages(threadId); return full; }
    patchMessage(threadId, id, patch) { const list = this.messagesFor(threadId), i = list.findIndex(m => m.id === id); if (i < 0)
        return null; list[i] = { ...list[i], ...patch, card: patch.card ?? list[i].card }; this.saveMessages(threadId); return list[i]; }
    bot(id) { return this.bots.find(b => b.id === id) ?? null; }
    botByThread(id) { return this.bots.find(b => b.threadId === id) ?? null; }
    createBot() { const bot = { id: newId(), threadId: newId(), name: "New Bot", title: "", description: "", notifications: true, color: COLORS[this.bots.length % COLORS.length], unread: false, modelSelection: this.defaultSelection(), resumeCursors: {}, computer: "off", busy: false, state: "IDLE", usage: zeroUsage(), createdAt: Date.now() }; this.bots.unshift(bot); this.saveBots(); this.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "Hey — I'm your new bot. Nice to meet you." }); this.appendMessage(bot.threadId, { role: "bot", kind: "options", card: onboardingCard() }); return bot; }
    deleteBot(id) { const b = this.bot(id); if (!b)
        return false; this.bots = this.bots.filter(x => x.id !== id); this.routines = this.routines.filter(r => r.botId !== id); this.saveBots(); this.saveRoutines(); this.messages.delete(b.threadId); try {
        unlinkSync(messagesFile(b.threadId));
    }
    catch { } return true; }
    patchBot(id, patch) { const b = this.bot(id); if (!b)
        return null; if (patch.computer && !MODES.has(patch.computer))
        throw new Error("invalid computer mode"); if (patch.state && !STATES.has(patch.state))
        throw new Error("invalid bot state"); Object.assign(b, patch); this.saveBots(); return b; }
    setResumeCursor(id, instance, cursor) { const b = this.bot(id); if (b) {
        b.resumeCursors[instance] = cursor;
        this.saveBots();
    } }
    recordTurnUsage(id, usage) { const b = this.bot(id); if (!b)
        return; const u = validUsage(usage); b.currentTurnUsage = u; b.usage = { input: b.usage.input + u.input, output: b.usage.output + u.output, cost: b.usage.cost === null && u.cost === null ? null : (b.usage.cost ?? 0) + (u.cost ?? 0) }; this.saveBots(); }
    seedIfEmpty() { if (this.bots.length)
        return; const b = this.createBot(); this.patchBot(b.id, { name: "Milind", color: "blue" }); }
    routine(id) { return this.routines.find(r => r.id === id) ?? null; }
    createRoutine(input) { if (!this.bot(input.botId))
        throw new Error("no such bot"); if (!input.name.trim() || !input.prompt.trim())
        throw new Error("name and prompt required"); const r = { id: newId(), ...input, name: input.name.trim(), prompt: input.prompt.trim(), enabled: true, running: false, nextRunAt: nextRunAt(input.schedule), lastRunAt: null, lastResult: null, createdAt: Date.now() }; this.routines.push(r); this.saveRoutines(); return r; }
    patchRoutine(id, patch) {
        const r = this.routine(id);
        if (!r)
            return null;
        const safe = {};
        if (patch.name !== undefined) {
            if (!patch.name.trim())
                throw new Error("name required");
            safe.name = patch.name.trim();
        }
        if (patch.prompt !== undefined) {
            if (!patch.prompt.trim())
                throw new Error("prompt required");
            safe.prompt = patch.prompt.trim();
        }
        if (patch.schedule !== undefined) {
            safe.schedule = patch.schedule;
            r.nextRunAt = nextRunAt(patch.schedule);
        }
        if (patch.enabled !== undefined)
            safe.enabled = patch.enabled === true;
        Object.assign(r, safe);
        this.saveRoutines();
        return r;
    }
    markRoutine(id, patch) { const r = this.routine(id); if (!r)
        return null; Object.assign(r, patch); this.saveRoutines(); return r; }
    deleteRoutine(id) { if (!this.routine(id))
        return false; this.routines = this.routines.filter(r => r.id !== id); this.saveRoutines(); return true; }
}
