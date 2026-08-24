import { describe, expect, it } from "vitest";

import { recordChannelEvents } from "../testing/channel-conformance.ts";
import { createFakeChannelConnector } from "../channels/fake.ts";
import { enforceDiscordAttachmentBounds } from "../channels/discord-protocol.ts";
import { prepareTelegramSend } from "../telegram.ts";
import { CHANNEL_UPLOAD_LIMITS, enforceChannelUploadLimits } from "./channel-limits.ts";

describe("channel upload limits", () => {
  it("rejects oversize and over-count on the P1 fake send path", async () => {
    const connector = createFakeChannelConnector({ id: "fake-limits", clock: { now: () => 1 } });
    const recorder = recordChannelEvents(connector);
    const address = connector.parseAddress("inbox");
    const tooBig = await connector.send({
      connectorId: connector.id,
      address,
      text: "hold",
      attachments: [{ id: "big", name: "huge.bin", sizeBytes: CHANNEL_UPLOAD_LIMITS.fake.maxBytes + 1 }],
    });
    expect(tooBig.state).toBe("failed");
    expect(tooBig.retry.retryable).toBe(false);
    expect(tooBig.error).toMatch(/byte limit/);
    await recorder.until((event) => event.type === "receipt" && event.receipt.state === "failed");

    const tooMany = await connector.send({
      connectorId: connector.id,
      address,
      text: "hold",
      attachments: Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, name: `n${i}.txt`, sizeBytes: 1 })),
    });
    expect(tooMany.state).toBe("failed");
    expect(tooMany.error).toMatch(/at most 10/);

    const ok = await connector.send({
      connectorId: connector.id,
      address,
      text: "ok",
      attachments: [{ id: "a1", name: "note.txt", mime: "text/plain", sizeBytes: 12 }],
    });
    expect(ok.state).toBe("sent");
    recorder.stop();
  });

  it("rejects oversize and over-count on Discord and Telegram send-path gates", () => {
    const discordBig = enforceDiscordAttachmentBounds([
      { id: "big", name: "huge.bin", sizeBytes: CHANNEL_UPLOAD_LIMITS.discord.maxBytes + 1 },
    ]);
    expect(discordBig.ok).toBe(false);
    if (discordBig.ok) throw new Error("expected reject");
    expect(discordBig.error).toMatch(/Discord attachment "huge.bin" exceeds/);

    const discordMany = enforceDiscordAttachmentBounds(
      Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, name: `n${i}.txt`, sizeBytes: 1 })),
    );
    expect(discordMany.ok).toBe(false);
    if (discordMany.ok) throw new Error("expected reject");
    expect(discordMany.error).toMatch(/Discord allows at most 10/);

    const telegramBig = prepareTelegramSend({
      text: "hold",
      attachments: [{ name: "huge.bin", sizeBytes: CHANNEL_UPLOAD_LIMITS.telegram.maxBytes + 1 }],
    });
    expect(telegramBig.ok).toBe(false);
    if (telegramBig.ok) throw new Error("expected reject");
    expect(telegramBig.error).toMatch(/Telegram attachment "huge.bin" exceeds/);

    const telegramMany = prepareTelegramSend({
      text: "hold",
      attachments: Array.from({ length: 11 }, (_, i) => ({ name: `n${i}.txt`, sizeBytes: 1 })),
    });
    expect(telegramMany.ok).toBe(false);
    if (telegramMany.ok) throw new Error("expected reject");
    expect(telegramMany.error).toMatch(/Telegram allows at most 10/);
  });

  it("accepts a valid count under the shared policy", () => {
    expect(
      enforceChannelUploadLimits("discord", [{ id: "a", name: "note.txt", sizeBytes: 12 }]),
    ).toEqual({ ok: true, attachments: [{ id: "a", name: "note.txt", sizeBytes: 12 }] });
  });
});
