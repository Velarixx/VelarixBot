// seedAvatar is the whole of Avatar Tier A: a pure function, so these
// tests need no server, no network, no filesystem.
import { describe, expect, it } from "vitest";

import { SEED_EXPRESSIONS, seedAvatar, validAvatarNonce } from "./avatar-seed.ts";
import { COLORS, ICON_SHAPES } from "./store.ts";

describe("seedAvatar", () => {
  it("is stable: the same botId + nonce always regenerates the same face", () => {
    const first = seedAvatar({ botId: "bot-abc123", nonce: 0 });
    for (let i = 0; i < 5; i++) {
      expect(seedAvatar({ botId: "bot-abc123", nonce: 0 })).toEqual(first);
    }
  });

  it("is stable for name-keyed seeds too", () => {
    const first = seedAvatar({ name: "Milind", nonce: 3 });
    expect(seedAvatar({ name: "Milind", nonce: 3 })).toEqual(first);
  });

  it("changes the face when the nonce changes", () => {
    const faces = new Set<string>();
    for (let nonce = 0; nonce < 10; nonce++) {
      const face = seedAvatar({ botId: "bot-abc123", nonce });
      faces.add(`${face.color}/${face.iconShape}/${face.mascotExpression}`);
    }
    // ten nonces must not collapse onto one face — re-roll must do something
    expect(faces.size).toBeGreaterThan(5);
  });

  it("keys on identity: different bots get different faces overall", () => {
    const a = seedAvatar({ botId: "bot-aaaaaa", nonce: 0 });
    const b = seedAvatar({ botId: "bot-zzzzzz", nonce: 0 });
    expect(`${a.color}/${a.iconShape}/${a.mascotExpression}`).not.toBe(
      `${b.color}/${b.iconShape}/${b.mascotExpression}`,
    );
  });

  it("only ever returns known colors, shapes, and pickable expressions", () => {
    for (let nonce = 0; nonce < 50; nonce++) {
      const face = seedAvatar({ botId: `bot-${nonce}`, nonce });
      expect(COLORS).toContain(face.color);
      expect(ICON_SHAPES).toContain(face.iconShape);
      expect(SEED_EXPRESSIONS).toContain(face.mascotExpression);
    }
  });

  it("prefers botId over name and tolerates a damaged nonce", () => {
    const byId = seedAvatar({ botId: "bot-abc123", name: "Renamed", nonce: 2 });
    expect(byId).toEqual(seedAvatar({ botId: "bot-abc123", nonce: 2 }));
    expect(seedAvatar({ botId: "bot-abc123", nonce: -4.5 })).toEqual(seedAvatar({ botId: "bot-abc123", nonce: 0 }));
  });

  it("validAvatarNonce accepts non-negative integers only", () => {
    expect(validAvatarNonce(0)).toBe(true);
    expect(validAvatarNonce(41)).toBe(true);
    expect(validAvatarNonce(-1)).toBe(false);
    expect(validAvatarNonce(1.5)).toBe(false);
    expect(validAvatarNonce("3")).toBe(false);
    expect(validAvatarNonce(null)).toBe(false);
  });
});
