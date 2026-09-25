import { expect, it } from "vitest";
import { bootHarness } from "./testing/harness.ts";

it("rejects an unreadable attachment before accepting a turn", async () => {
  const harness = await bootHarness({ instances: {} });
  try {
    const created = await harness.api("POST", "/api/bots", { name: "Attachment test" });
    const response = await harness.api("POST", `/api/bots/${created.body.bot.id}/messages`, {
      text: "Read the attached file", attachments: [{ path: "/definitely-missing-review-file.pdf" }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Couldn’t read attachment");
    const snapshot = await harness.api("GET", "/api/events/snapshot");
    const bot = snapshot.body.bots.find((bot: { id: string }) => bot.id === created.body.bot.id);
    expect(bot.messages.some((message: { text?: string }) => message.text === "Read the attached file")).toBe(false);
  } finally { await harness.stop(); }
});
