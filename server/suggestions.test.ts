// PRO cards: fake extract → cards only. Accept uses createRoutine /
// insertMemoryRow. Dismiss writes nothing. Cross-bot never cards.
// No sleeps; HOME is the vitest temp dir.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import {
  configureMemoryStore,
  editMemoryRow,
  extractMemory,
  listMemoryRows,
  pinMemoryRow,
} from "./memory.ts";
import { createRepositories, type Repositories } from "./repositories/index.ts";
import { createBotsRoutes } from "./routes/bots.ts";
import { createBotsService, type BotsService } from "./services/bots.ts";
import { createRoutinesService, type RoutinesService } from "./services/routines.ts";
import {
  acceptSuggestion,
  cardAnswerStartsTurn,
  isSuggestionAccept,
  SUGGESTION_ACCEPT_MEMORY,
  SUGGESTION_ACCEPT_WORKFLOW,
  suggestionCardsFor,
} from "./suggestions.ts";

const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

const FAKE_EXTRACT = JSON.stringify([
  { type: "workflow", text: "Check PRs every weekday morning." },
  { type: "fact", text: "Lives in Austin." },
]);

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("PRO suggestion cards", () => {
  let db: SqliteDatabase;
  let repos: Repositories;
  let bots: BotsService;
  let routines: RoutinesService;
  let startedTurns: string[];

  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    db = openDatabase(defaultDbPath());
    repos = createRepositories(db);
    configureMemoryStore(repos.memoryRows);
    bots = createBotsService({ repos, defaultSelection: selection });
    startedTurns = [];
    routines = createRoutinesService({
      repos,
      now: () => 1_000,
      broadcast: () => {},
      bot: (id) => bots.bot(id),
      startTurn: async (botId, text) => {
        startedTurns.push(`${botId}:${text}`);
      },
      getSkill: () => null,
      skillPrompt: (_skill, prompt) => prompt,
    });
  });

  afterEach(() => {
    configureMemoryStore(null);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("does not change P0.1 Allow copy or persist rules", () => {
    const card = readFileSync(new URL("../src/components/OptionCard.tsx", import.meta.url), "utf8");
    const approvals = readFileSync(new URL("./approvals.ts", import.meta.url), "utf8");
    expect(card).toContain("Always allow for this bot");
    expect(card).toContain("Advanced: always allow for all bots");
    expect(card).toContain('answer: "Allow once"');
    expect(card).toContain('persistScope: "workspace"');
    expect(approvals).toContain("Allow once");
    expect(approvals).toContain("Always allow for this bot");
  });

  it("card answers never start a turn for suggestion or live asks", () => {
    expect(cardAnswerStartsTurn({ title: "Next", subtitle: "", options: ["A"] })).toBe(true);
    expect(cardAnswerStartsTurn({ title: "Ask", subtitle: "", options: ["Yes"], requestId: "r1" })).toBe(false);
    expect(
      cardAnswerStartsTurn({
        title: "Remember this?",
        subtitle: "Lives in Austin.",
        options: [SUGGESTION_ACCEPT_MEMORY],
        requestType: "suggestion",
      }),
    ).toBe(false);
  });

  it("fake extract produces one workflow + one fact card; accept writes; dismiss does not; no cross-bot card", async () => {
    const a = bots.createBot();
    const b = bots.createBot();
    const extracted = await extractMemory({
      botId: a.id,
      turnText: "User: I live in Austin. Please check PRs every weekday morning.\n\nBot: Noted.",
      generateText: async () => FAKE_EXTRACT,
    });
    expect(extracted).toEqual([
      { type: "workflow", text: "Check PRs every weekday morning." },
      { type: "fact", text: "Lives in Austin." },
    ]);
    expect(listMemoryRows(a.id)).toEqual([]);
    expect(listMemoryRows(b.id)).toEqual([]);
    expect(routines.routines()).toEqual([]);

    const cards = suggestionCardsFor(a.id, extracted, {
      existingRows: [...listMemoryRows(a.id), ...listMemoryRows(b.id)],
      existingCards: bots.messagesFor(a.threadId).map((m) => m.card).filter((c): c is NonNullable<typeof c> => !!c),
    });
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.suggestion?.type)).toEqual(["workflow", "fact"]);
    expect(cards.every((c) => c.suggestion?.botId === a.id)).toBe(true);
    expect(suggestionCardsFor(b.id, extracted, { existingRows: listMemoryRows(b.id) })).toEqual([]);

    const workflowMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: cards[0] });
    const factMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: cards[1] });
    expect(bots.messagesFor(b.threadId).some((m) => m.card?.requestType === "suggestion")).toBe(false);

    expect(isSuggestionAccept(workflowMsg.card!, SUGGESTION_ACCEPT_WORKFLOW)).toBe(true);
    const workflow = acceptSuggestion({
      botId: a.id,
      suggestion: workflowMsg.card!.suggestion!,
      createRoutine: (input) => routines.createRoutine(input),
    });
    expect(workflow.kind).toBe("routine");
    expect(routines.routines()).toHaveLength(1);
    expect(routines.routines()[0]).toMatchObject({
      botId: a.id,
      prompt: "Check PRs every weekday morning.",
      schedule: { kind: "weekdays", time: "09:00" },
    });
    expect(startedTurns).toEqual([]);

    const fact = acceptSuggestion({
      botId: a.id,
      suggestion: factMsg.card!.suggestion!,
      createRoutine: (input) => routines.createRoutine(input),
    });
    expect(fact.kind).toBe("memory");
    const rows = listMemoryRows(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "fact", text: "Lives in Austin.", botId: a.id });
    const pinned = pinMemoryRow(rows[0]!.id, true);
    expect(pinned?.pinned).toBe(true);
    expect(editMemoryRow(rows[0]!.id, "Current city is Austin.")?.text).toBe("Current city is Austin.");
    expect(listMemoryRows(b.id)).toEqual([]);
    expect(startedTurns).toEqual([]);

    const dismissed = suggestionCardsFor(a.id, [{ type: "preference", text: "Prefers short answers." }]);
    expect(dismissed).toHaveLength(1);
    bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: { ...dismissed[0]!, dismissed: true } });
    expect(listMemoryRows(a.id)).toHaveLength(1);
    expect(routines.routines()).toHaveLength(1);
    expect(startedTurns).toEqual([]);

    expect(
      acceptSuggestion({
        botId: b.id,
        suggestion: { botId: a.id, type: "fact", text: "Other bot should not see this." },
        createRoutine: (input) => routines.createRoutine(input),
      }),
    ).toEqual({ kind: "none" });
    expect(listMemoryRows(b.id)).toEqual([]);
  });

  it("PATCH accept/dismiss on the existing card route writes only on accept", async () => {
    const a = bots.createBot();
    const b = bots.createBot();
    const extracted = await extractMemory({
      botId: a.id,
      turnText: "User: I live in Austin. Check PRs weekdays.\n\nBot: Ok.",
      generateText: async () => FAKE_EXTRACT,
    });
    const cards = suggestionCardsFor(a.id, extracted);
    const workflowMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: cards[0] });
    const factMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: cards[1] });
    const extra = suggestionCardsFor(a.id, [{ type: "preference", text: "Call me Sam." }]);
    const dismissMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: extra[0] });

    const handler = createBotsRoutes({
      bots,
      turns: {} as never,
      teach: {} as never,
      routines,
      registry: {} as never,
      computers: {} as never,
      cfg: {} as never,
      broadcast: () => {},
    });
    const { base, close } = await listen((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void handler({ req, res, url, path: url.pathname, method: req.method ?? "GET" });
    });
    try {
      const patch = async (botId: string, messageId: string, body: unknown) => {
        const res = await fetch(`${base}/api/bots/${botId}/cards/${messageId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
      };

      const acceptedWorkflow = await patch(a.id, workflowMsg.id, { answered: SUGGESTION_ACCEPT_WORKFLOW });
      expect(acceptedWorkflow.status).toBe(200);
      expect(routines.routines()).toHaveLength(1);
      expect(startedTurns).toEqual([]);

      const acceptedFact = await patch(a.id, factMsg.id, { answered: SUGGESTION_ACCEPT_MEMORY });
      expect(acceptedFact.status).toBe(200);
      expect(listMemoryRows(a.id)).toHaveLength(1);
      expect(listMemoryRows(a.id)[0]).toMatchObject({ type: "fact", text: "Lives in Austin." });

      const dismissed = await patch(a.id, dismissMsg.id, { dismissed: true });
      expect(dismissed.status).toBe(200);
      expect(dismissed.body.message.card.dismissed).toBe(true);
      expect(listMemoryRows(a.id)).toHaveLength(1);
      expect(routines.routines()).toHaveLength(1);

      const cross = await patch(b.id, workflowMsg.id, { answered: SUGGESTION_ACCEPT_WORKFLOW });
      expect(cross.status).toBe(404);
      expect(listMemoryRows(b.id)).toEqual([]);
      expect(startedTurns).toEqual([]);
    } finally {
      await close();
    }
  });
});
