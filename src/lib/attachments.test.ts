import { describe, expect, it } from "vitest";
import { chipFromDroppedFile, sendPayload } from "./attachments";

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

  it("allows send with chips and no text, and uses the filename when path is missing", () => {
    const chip = chipFromDroppedFile({ name: "notes.md" }, "att-2");
    expect(chip).toEqual({ id: "att-2", name: "notes.md", path: "notes.md", mime: undefined });
    expect(sendPayload("  ", [chip!])).toEqual({
      text: "",
      attachments: [{ path: "notes.md" }],
    });
  });

  it("does not invent a chip from an empty drop", () => {
    expect(chipFromDroppedFile({ name: "" }, "x")).toBeNull();
  });
});
