// P2.6 memory retrieval evals (GATE). Deterministic cases over a fixed
// fixture corpus — substring recall + whole-file inject as they exist
// today. No live model, no new ranker, no Playwright chat flow.
// Assertions report only missing/leaked tokens — never the corpus text,
// distill prompts, or memory file contents.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../server/config.ts";
import { memoryPrompt, recallMemory, writeBotMemory, writeWorkspace } from "../server/memory.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(ROOT, "retrieval", "fixture.json");

type RetrievalMode = "recall" | "inject";
type Gate = "a" | "b" | "c";

type CorpusBot = { user: string; distilled: string };

type RetrievalCase = {
  id: string;
  gate: Gate;
  mode: RetrievalMode;
  botId: string;
  query?: string;
  expect: string[];
  forbid: string[];
};

type Fixture = {
  bots: Record<string, CorpusBot>;
  workspace: string;
  cases: RetrievalCase[];
};

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

function underDir(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function seedCorpus(): void {
  writeWorkspace(fixture.workspace);
  for (const [botId, parts] of Object.entries(fixture.bots)) {
    writeBotMemory(botId, { user: parts.user, distilled: parts.distilled });
  }
}

function retrieve(c: RetrievalCase): string {
  if (c.mode === "inject") return memoryPrompt(c.botId);
  return recallMemory(c.botId, c.query);
}

/** Token presence only — never echo the retrieved text. */
function assertTokens(c: RetrievalCase, text: string): void {
  const missing = c.expect.filter((token) => !text.includes(token));
  const leaked = c.forbid.filter((token) => text.includes(token));
  expect({ id: c.id, missing, leaked }).toEqual({ id: c.id, missing: [], leaked: [] });
}

beforeEach(() => {
  seedCorpus();
});

describe("P2.6 memory retrieval evals", () => {
  it("runs against a throwaway HOME, never the real ~/.velarixbot", () => {
    const home = process.env.HOME ?? "";
    expect(home.length).toBeGreaterThan(0);
    expect(underDir(tmpdir(), home)).toBe(true);
    expect(process.env.USERPROFILE).toBe(home);
    expect(underDir(home, DATA_DIR)).toBe(true);
  });

  it("covers gates (a) right recall, (b) stale not applied, (c) no cross-bot leak", () => {
    const gates = new Set(fixture.cases.map((c) => c.gate));
    expect([...gates].sort()).toEqual(["a", "b", "c"]);
    expect(fixture.cases.some((c) => c.gate === "a" && c.mode === "recall" && c.query)).toBe(true);
    expect(fixture.cases.some((c) => c.gate === "b" && c.mode === "recall" && c.query)).toBe(true);
    expect(fixture.cases.some((c) => c.gate === "c" && c.botId === "bot-a")).toBe(true);
    expect(fixture.cases.some((c) => c.gate === "c" && c.botId === "bot-b")).toBe(true);
  });

  it("does not log distill prompts or memory file contents", () => {
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    expect(src).not.toMatch(/console\.(log|info|debug|dir|table)\(/);
    expect(src).not.toMatch(/\bimport\b[^;]*\bdistill/);
  });

  for (const c of fixture.cases) {
    it(`${c.gate}: ${c.id}`, () => {
      assertTokens(c, retrieve(c));
    });
  }
});
