import { describe, expect, it } from "vitest";
import { chipFromDroppedFile, prepareDroppedFiles, sendPayload } from "./attachments";

describe("composer attachments", () => {
  it("turns a dropped file into a chip and a send payload with path refs", () => {
    const chip = chipFromDroppedFile(
      { name: "shot.png", path: "/tmp/shot.png", type: "image/png" },
      "att-1",
    );
    expect(chip).toEqual({ id: "att-1", name: "shot.png", path: "/tmp/shot.png", mime: "image/png" });
    const payload = sendPayload("look at this", [chip!]);
    expect(payload).toEqual({
      text: "look at this",
      attachments: [{ path: "/tmp/shot.png", mime: "image/png" }],
    });
  });

  it("requires a real path and supports attachment-only messages", () => {
    expect(chipFromDroppedFile({ name: "notes.md" }, "att-2")).toBeNull();
    const chip = chipFromDroppedFile({ name: "notes.md", path: "/tmp/notes.md" }, "att-2");
    expect(sendPayload("  ", [chip!])).toEqual({
      text: "",
      attachments: [{ path: "/tmp/notes.md" }],
    });
  });

  it("uses Electron's path bridge and persists clipboard bytes when there is no backing file", async () => {
    const file = new File(["sample"], "notes.md", { type: "text/plain" });
    const disk = await prepareDroppedFiles([file], { attachmentPath: () => "/tmp/notes.md" });
    expect(disk.files[0].path).toBe("/tmp/notes.md");
    const image = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const pasted = await prepareDroppedFiles([image], { attachmentPath: () => "", saveClipboardImage: async ({ bytes }) => { expect([...bytes]).toEqual([1, 2, 3]); return { path: "/tmp/saved.png", name: "Pasted image.png" }; } });
    expect(pasted.files[0].path).toBe("/tmp/saved.png");
    const unsupported = await prepareDroppedFiles([file], undefined);
    expect(unsupported.files).toEqual([]);
    expect(unsupported.errors[0]).toContain("desktop app");
  });

  it("does not invent a chip from an empty drop", () => {
    expect(chipFromDroppedFile({ name: "" }, "x")).toBeNull();
  });
});
