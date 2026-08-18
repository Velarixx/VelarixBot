import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newBotRequestBody } from "@/state/store";
import { filterSidebarBots } from "@/lib/sidebar";
import { SLASH_COMMANDS } from "@/lib/slash-commands";

const HERE = dirname(fileURLToPath(import.meta.url));
const modal = readFileSync(join(HERE, "CreateBotModal.tsx"), "utf8");
const sidebar = readFileSync(join(HERE, "Sidebar.tsx"), "utf8");
const composer = readFileSync(join(HERE, "Composer.tsx"), "utf8");
const app = readFileSync(join(HERE, "../App.tsx"), "utf8");
const store = readFileSync(join(HERE, "../state/store.tsx"), "utf8");
const picker = readFileSync(join(HERE, "ModelPicker.tsx"), "utf8");
const settings = readFileSync(join(HERE, "SettingsPanel.tsx"), "utf8");

describe("single-modal teammate create", () => {
  it("Plus, /new, and empty-state open the one modal — they do not empty-POST", () => {
    expect(app).toContain("<CreateBotModal");
    expect(app.match(/<CreateBotModal/g)?.length).toBe(1);
    expect(sidebar).not.toContain("CreateBotModal");
    expect(composer).not.toContain("CreateBotModal");
    expect(sidebar).toContain('dispatch({ type: "toggleCreateBot", open: true })');
    expect(composer).toContain('dispatch({ type: "toggleCreateBot", open: true })');
    expect(app).toContain('dispatch({ type: "toggleCreateBot", open: true })');
    expect(app).toContain("Create a bot");
    expect(sidebar).not.toContain('dispatch({ type: "newBot" })');
    expect(composer).not.toMatch(/case "newBot":\s+dispatch\(\{ type: "newBot" \}\)/);
    expect(app).not.toContain('dispatch({ type: "newBot" })');
    expect(store).not.toMatch(/case "newBot":\s+api\("\/api\/bots", \{ method: "POST" \}\)/);
  });

  it("is one modal with name, title, description, color, procedural avatar, and ModelPicker", () => {
    expect(modal).toContain('Field label="Name"');
    expect(modal).toContain('Field label="Title"');
    expect(modal).toContain('Field label="Description"');
    expect(modal).toContain("Describe what your agent does");
    expect(modal).toContain("What this agent is for");
    expect(modal).toContain("MAUS_COLOR_NAMES");
    expect(modal).toContain("<BotFace");
    expect(modal).toContain("<ModelPicker");
    expect(modal).not.toMatch(/CreateBotWizard|step === 1|setStep/);
    expect(modal).not.toMatch(/marketplace|group room|voice/i);
    expect(modal).not.toMatch(/computer:|alwaysAllow|patch\(\{\s*computer/);
    expect(modal).not.toContain("/api/bots/create");
    expect(modal).not.toContain("create_bot");
  });

  it("confirm POSTs a named body; first sidebar row is that name", () => {
    expect(modal).toContain('type: "newBot"');
    expect(modal).toContain("...payload");
    expect(store).toContain("postNewBot(action)");
    expect(store).toContain("JSON.stringify(newBotRequestBody(init))");
    const body = newBotRequestBody({
      name: "Scout",
      title: "Field scout",
      description: "Looks around",
      color: "green",
      model: "claude-sonnet-5",
    });
    expect(body).toEqual({
      name: "Scout",
      title: "Field scout",
      description: "Looks around",
      color: "green",
      model: "claude-sonnet-5",
    });
    expect(body).not.toHaveProperty("computer");
    expect(body).not.toHaveProperty("alwaysAllow");
    const rows = filterSidebarBots(
      [
        { id: "new", name: body.name, hidden: false },
        { id: "old", name: "New Bot", hidden: false },
      ],
      "",
    );
    expect(rows[0]?.name).toBe("Scout");
    expect(rows[0]?.name).not.toBe("New Bot");
  });

  it("hides Generate portraits without an image key and uses the existing generate route after named create", () => {
    expect(modal).toContain("imageReady");
    expect(modal).toContain("xai?.configured");
    expect(modal).toContain("openai?.configured");
    expect(modal).toContain("openrouter?.configured");
    expect(modal).toContain("{imageReady && (");
    expect(modal).toContain("Generate portraits");
    expect(modal).toContain("postNewBot(payload)");
    expect(modal).toContain("`/api/bots/${bot.id}/avatar/generate`");
    expect(modal).toContain('method: "POST"');
    expect(modal).not.toContain("/avatar/create");
    expect(modal).not.toContain("/api/portraits");
  });

  it("reuses ModelPicker — unavailable instances stay dimmed with snapshot.reason", () => {
    expect(modal).toContain("<ModelPicker bot={preview}");
    expect(picker).toContain('instance.snapshot.state !== "available"');
    expect(picker).toContain("instance.snapshot.reason");
    expect(picker).toContain("railInstance.snapshot.reason");
    expect(picker).toContain("unavailable && \"opacity-40\"");
    expect(settings).toContain("<ModelPicker bot={bot} />");
  });

  it("does not invent slash commands, a second create API, or P0.1 Always-allow copy", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(["new", "model", "computer", "attach", "stop", "help"]);
    expect(settings).toContain('aria-label="Always allow"');
    expect(settings).toMatch(/Let this bot do routine reads, writes, tool calls, and connected-app actions without/);
    expect(store).not.toContain("/api/bots/create");
  });
});
