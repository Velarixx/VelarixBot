// PRO cards: fake extract → cards only. Accept uses createRoutine /
// insertMemoryRow. Dismiss writes nothing. Cross-bot never cards.
// No sleeps; HOME is the vitest temp dir.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, rmSync } from "node:fs";
import {
  createSourceFile,
  forEachChild,
  isBinaryExpression,
  isBlock,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isIfStatement,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSpreadAssignment,
  isStringLiteralLike,
  isVariableDeclaration,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  type Expression,
  type Node,
  type ObjectLiteralExpression,
} from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { defaultDbPath, openDatabase } from "./db/database.ts";
import type { SqliteDatabase } from "./db/sqlite-native.ts";
import {
  configureMemoryStore,
  editMemoryRow,
  extractMemory,
  insertMemoryRow,
  listMemoryRows,
  memoryPrompt,
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
  suggestionItemsFromRepeatedWorkflows,
  SUGGESTION_ACCEPT_MEMORY,
  SUGGESTION_ACCEPT_WORKFLOW,
  SUGGESTION_REQUEST_TYPE,
  suggestionCardsFor,
  WORKFLOW_ROUTINE_PROMPT_USE_COUNT,
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

  it("submits canonical P0.1 approval scopes without persisting Deny or credentials", () => {
    const card = readFileSync(new URL("../src/components/OptionCard.tsx", import.meta.url), "utf8");
    const sourceFile = createSourceFile("OptionCard.tsx", card, ScriptTarget.Latest, true, ScriptKind.TSX);
    const nodes: Node[] = [];
    const visit = (node: Node) => {
      nodes.push(node);
      forEachChild(node, visit);
    };
    visit(sourceFile);

    const approvalFunction = nodes.filter(isFunctionDeclaration).find((node) =>
      node.name?.text === "approvalResponse");
    if (!approvalFunction?.body) throw new Error("approvalResponse function not found");
    const approvalBody = approvalFunction.body;

    const responseDeclaration = nodes.filter(isVariableDeclaration).find((node) =>
      isIdentifier(node.name)
      && node.name.text === "response"
      && node.initializer !== undefined
      && isObjectLiteralExpression(node.initializer));
    const responseInitializer = responseDeclaration?.initializer;
    if (!responseInitializer || !isObjectLiteralExpression(responseInitializer)) {
      throw new Error("approvalResponse base payload not found");
    }

    type Payload = Record<string, string | boolean>;
    const decodeObject = (object: ObjectLiteralExpression, bindings: Record<string, Payload> = {}): Payload => {
      const decoded: Payload = {};
      for (const property of object.properties) {
        if (isSpreadAssignment(property) && isIdentifier(property.expression)) {
          Object.assign(decoded, bindings[property.expression.text]);
          continue;
        }
        if (!isPropertyAssignment(property)) throw new Error("Unsupported approval payload property");
        const name = isIdentifier(property.name) || isStringLiteralLike(property.name)
          ? property.name.text
          : property.name.getText(sourceFile);
        if (isStringLiteralLike(property.initializer)) decoded[name] = property.initializer.text;
        else if (property.initializer.kind === SyntaxKind.TrueKeyword) decoded[name] = true;
        else if (property.initializer.kind === SyntaxKind.FalseKeyword) decoded[name] = false;
        else throw new Error(`Unsupported value for approval payload property ${name}`);
      }
      return decoded;
    };
    const base = decodeObject(responseInitializer);
    const decodePayload = (expression: Expression): Payload => {
      if (isIdentifier(expression) && expression.text === "response") return { ...base };
      if (isObjectLiteralExpression(expression)) return decodeObject(expression, { response: base });
      throw new Error("Unsupported approval response expression");
    };
    const scopedPayload = (scope: string): Payload => {
      const branch = approvalBody.statements.find((statement) =>
        isIfStatement(statement)
        && isBinaryExpression(statement.expression)
        && isIdentifier(statement.expression.left)
        && statement.expression.left.text === "scope"
        && statement.expression.operatorToken.kind === SyntaxKind.EqualsEqualsEqualsToken
        && isStringLiteralLike(statement.expression.right)
        && statement.expression.right.text === scope);
      if (!branch || !isIfStatement(branch)) throw new Error(`approvalResponse ${scope} branch not found`);
      const returned = isReturnStatement(branch.thenStatement)
        ? branch.thenStatement
        : isBlock(branch.thenStatement)
          ? branch.thenStatement.statements.find(isReturnStatement)
          : undefined;
      if (!returned?.expression) throw new Error(`approvalResponse ${scope} payload not found`);
      return decodePayload(returned.expression);
    };
    const finalReturn = [...approvalBody.statements].reverse().find(isReturnStatement);
    if (!finalReturn?.expression) throw new Error("approvalResponse workspace payload not found");

    expect(scopedPayload("bot")).toStrictEqual({ answer: "Allow once", always: true });
    expect(decodePayload(finalReturn.expression)).toStrictEqual({
      answer: "Allow once",
      always: true,
      persistScope: "workspace",
    });

    const calls = nodes.filter(isCallExpression);
    const submittedScopes = calls.flatMap((call) => {
      if (!isIdentifier(call.expression) || call.expression.text !== "submitResponse") return [];
      const response = call.arguments[0];
      if (!response || !isCallExpression(response) || !isIdentifier(response.expression)
        || response.expression.text !== "approvalResponse") return [];
      const scope = response.arguments[0];
      return scope && isStringLiteralLike(scope) ? [scope.text] : [];
    });
    expect(submittedScopes.sort()).toStrictEqual(["bot", "once", "workspace"]);

    const answerCalls = calls.filter((call) => isIdentifier(call.expression) && call.expression.text === "answer");
    const optionAnswer = answerCalls.find((call) => isIdentifier(call.arguments[0]) && call.arguments[0].text === "opt");
    expect(optionAnswer?.arguments).toHaveLength(1);
    const credentialAnswer = answerCalls.find((call) =>
      isStringLiteralLike(call.arguments[0]) && call.arguments[0].text === "••••");
    const credentialResponse = credentialAnswer?.arguments[1];
    expect(credentialResponse && isObjectLiteralExpression(credentialResponse)
      ? credentialResponse.properties.map((property) => property.name?.getText(sourceFile))
      : []).toStrictEqual(["secret"]);
    for (const call of answerCalls) {
      const response = call.arguments[1];
      if (!response || !isObjectLiteralExpression(response)) continue;
      const names = response.properties.map((property) => property.name?.getText(sourceFile));
      expect(names).not.toContain("always");
      expect(names).not.toContain("persistScope");
    }
  });

  it("card answers never start a turn for suggestion or live asks", () => {
    expect(cardAnswerStartsTurn({ requestType: undefined })).toBe(true);
    expect(cardAnswerStartsTurn({ requestId: "r1" })).toBe(false);
    expect(cardAnswerStartsTurn({ requestType: "suggestion" })).toBe(false);
  });

  it("fake extract produces one workflow + one fact card; accept writes; dismiss does not; no cross-bot card", async () => {
    const a = bots.createBot();
    const b = bots.createBot();
    repos.memoryRows.insert({ botId: b.id, type: "fact", text: "Ops alias is pager-lee in Austin." });
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
    expect(listMemoryRows(b.id).map((r) => r.text)).toEqual(["Ops alias is pager-lee in Austin."]);
    expect(routines.routines()).toEqual([]);

    const cards = suggestionCardsFor(a.id, extracted, {
      existingRows: [...listMemoryRows(a.id), ...listMemoryRows(b.id)],
      existingCards: bots.messagesFor(a.threadId).map((m) => m.card).filter((c): c is NonNullable<typeof c> => !!c),
    });
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.suggestion?.type)).toEqual(["workflow", "fact"]);
    expect(cards.every((c) => c.suggestion?.botId === a.id)).toBe(true);
    expect(cards.some((c) => /pager-lee/i.test(c.subtitle))).toBe(false);

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
    expect(listMemoryRows(b.id).map((r) => r.text)).toEqual(["Ops alias is pager-lee in Austin."]);
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
    expect(listMemoryRows(b.id).map((r) => r.text)).toEqual(["Ops alias is pager-lee in Austin."]);
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
        return { status: res.status, body: (await res.json()) as { message?: { card?: { dismissed?: boolean } } } };
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
      expect(dismissed.body.message?.card?.dismissed).toBe(true);
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

  it("high-useCount workflow after inject bump emits the existing suggestion card; accept creates a routine; dismiss no-ops", async () => {
    const a = bots.createBot();
    const b = bots.createBot();
    const now = 9_000;
    insertMemoryRow({
      botId: a.id,
      type: "workflow",
      text: "Check PRs every weekday morning.",
      useCount: WORKFLOW_ROUTINE_PROMPT_USE_COUNT - 1,
      now,
    });
    insertMemoryRow({
      botId: a.id,
      type: "fact",
      text: "Lives in Austin.",
      useCount: WORKFLOW_ROUTINE_PROMPT_USE_COUNT,
      now,
    });
    insertMemoryRow({
      botId: b.id,
      type: "workflow",
      text: "Page Lee on-call at 3am.",
      useCount: 99,
      now,
    });

    expect(suggestionItemsFromRepeatedWorkflows(a.id, listMemoryRows(a.id))).toEqual([]);
    const prompt = memoryPrompt(a.id, now);
    expect(prompt).toContain("Check PRs every weekday morning.");
    expect(prompt).not.toContain("Page Lee");
    expect(listMemoryRows(a.id).find((r) => r.type === "workflow")?.useCount).toBe(WORKFLOW_ROUTINE_PROMPT_USE_COUNT);
    expect(listMemoryRows(b.id)[0]?.useCount).toBe(99);

    const fromUse = suggestionItemsFromRepeatedWorkflows(a.id, [
      ...listMemoryRows(a.id),
      ...listMemoryRows(b.id),
    ]);
    expect(fromUse).toEqual([{ type: "workflow", text: "Check PRs every weekday morning." }]);

    const cards = suggestionCardsFor(a.id, fromUse, {
      existingCards: bots.messagesFor(a.threadId).map((m) => m.card).filter((c): c is NonNullable<typeof c> => !!c),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "Save as a routine?",
      options: [SUGGESTION_ACCEPT_WORKFLOW],
      requestType: SUGGESTION_REQUEST_TYPE,
      suggestion: { botId: a.id, type: "workflow", text: "Check PRs every weekday morning." },
    });
    expect(cards[0]!.subtitle).not.toMatch(/Page Lee/i);
    expect(isSuggestionAccept(cards[0]!, SUGGESTION_ACCEPT_WORKFLOW)).toBe(true);
    expect(cardAnswerStartsTurn(cards[0])).toBe(false);

    const workflowMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: cards[0] });
    expect(bots.messagesFor(b.threadId).some((m) => m.card?.requestType === SUGGESTION_REQUEST_TYPE)).toBe(false);

    const accepted = acceptSuggestion({
      botId: a.id,
      suggestion: workflowMsg.card!.suggestion!,
      createRoutine: (input) => routines.createRoutine(input),
    });
    expect(accepted.kind).toBe("routine");
    expect(routines.routines()).toHaveLength(1);
    expect(routines.routines()[0]).toMatchObject({
      botId: a.id,
      prompt: "Check PRs every weekday morning.",
      schedule: { kind: "weekdays", time: "09:00" },
    });
    expect(startedTurns).toEqual([]);
    expect(listMemoryRows(a.id).filter((r) => r.type === "workflow")).toHaveLength(1);
    expect(listMemoryRows(b.id).map((r) => r.text)).toEqual(["Page Lee on-call at 3am."]);

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
      const dismissCards = suggestionCardsFor(a.id, [{ type: "workflow", text: "Draft the weekly notes." }]);
      const dismissMsg = bots.appendMessage(a.threadId, { role: "bot", kind: "options", card: dismissCards[0] });
      const rowsBefore = listMemoryRows(a.id).length;
      const routinesBefore = routines.routines().length;
      const res = await fetch(`${base}/api/bots/${a.id}/cards/${dismissMsg.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dismissed: true }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { message?: { card?: { dismissed?: boolean } } }).message?.card?.dismissed).toBe(true);
      expect(listMemoryRows(a.id)).toHaveLength(rowsBefore);
      expect(routines.routines()).toHaveLength(routinesBefore);
      expect(startedTurns).toEqual([]);

      const again = suggestionCardsFor(a.id, fromUse, {
        existingCards: bots.messagesFor(a.threadId).map((m) => m.card).filter((c): c is NonNullable<typeof c> => !!c),
      });
      expect(again).toEqual([]);
    } finally {
      await close();
    }
  });
});
