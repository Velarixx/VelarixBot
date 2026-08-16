import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AVATAR_CANDIDATE_COUNT,
  avatarPrompt,
  collectAvatarHashes,
  configuredAvatarProviders,
  fakeGenerateAvatarImages,
  generateAvatarImagesForConfig,
  generateAvatarImagesHttp,
  pickAvatarProvider,
  solidPng,
  storeAvatarImages,
} from "./avatar-image.ts";
import { blobsDir, hashBytes, putBlob } from "./db/blobs.ts";

describe("avatarPrompt", () => {
  it("builds a prompt from name and personality, and still works with empty fields", () => {
    expect(avatarPrompt({ name: "Scout", title: "Researcher", description: "Curious and brief." })).toMatch(
      /Scout[\s\S]*Researcher[\s\S]*Curious and brief/,
    );
    expect(avatarPrompt({ name: "  " })).toMatch(/helpful assistant/);
    expect(avatarPrompt({})).toMatch(/helpful assistant/);
  });
});

describe("pickAvatarProvider", () => {
  it("returns null with zero keys — generate is optional", () => {
    expect(configuredAvatarProviders({})).toEqual([]);
    expect(pickAvatarProvider({})).toBeNull();
    expect(pickAvatarProvider({ xai: { url: "https://api.x.ai/v1" } })).toBeNull();
  });

  it("picks the first configured of xai, openai, openrouter, and honors a requested one", () => {
    const cfg = {
      xai: { key: "xai-fake" },
      openai: { key: "sk-fake" },
      openrouter: { key: "or-fake" },
    };
    expect(configuredAvatarProviders(cfg)).toEqual(["xai", "openai", "openrouter"]);
    expect(pickAvatarProvider(cfg)).toBe("xai");
    expect(pickAvatarProvider(cfg, "openai")).toBe("openai");
    expect(pickAvatarProvider({ openrouter: { key: "or-fake" } }, "xai")).toBeNull();
    expect(pickAvatarProvider(cfg, "dicebear")).toBeNull();
  });
});

describe("storeAvatarImages + fake generator", () => {
  it("writes four distinct blobs on disk and never needs a network", async () => {
    const images = await fakeGenerateAvatarImages({
      prompt: "test",
      count: AVATAR_CANDIDATE_COUNT,
      provider: "xai",
      apiKey: "unused",
    });
    expect(images).toHaveLength(4);
    const candidates = storeAvatarImages(images);
    expect(candidates).toHaveLength(4);
    const hashes = new Set(candidates.map((c) => c.hash));
    expect(hashes.size).toBe(4);
    for (const c of candidates) {
      expect(existsSync(join(blobsDir(), c.hash))).toBe(true);
      expect(readFileSync(join(blobsDir(), c.hash)).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(
        true,
      );
    }
  });

  it("rejects fewer than four images", () => {
    expect(() => storeAvatarImages([{ bytes: solidPng(2, 2, [1, 2, 3]), mime: "image/png" }])).toThrow(/need 4/);
  });
});

describe("generateAvatarImagesForConfig", () => {
  it("409s with zero keys and never calls the generator", async () => {
    let called = false;
    await expect(
      generateAvatarImagesForConfig(
        {},
        {
          prompt: "hi",
          generate: async () => {
            called = true;
            return [];
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/no image provider/i) });
    expect(called).toBe(false);
  });

  it("uses the injected generator and stores the four blobs", async () => {
    const seen: string[] = [];
    const result = await generateAvatarImagesForConfig(
      { xai: { key: "xai-not-a-real-key" } },
      {
        prompt: "Scout the researcher",
        generate: async (input) => {
          seen.push(input.provider, input.prompt, input.apiKey);
          return fakeGenerateAvatarImages(input);
        },
      },
    );
    expect(result.provider).toBe("xai");
    expect(result.candidates).toHaveLength(4);
    expect(seen[0]).toBe("xai");
    expect(seen[1]).toContain("Scout the researcher");
    expect(seen[2]).toBe("xai-not-a-real-key");
  });
});

describe("generateAvatarImagesHttp (injected fetch)", () => {
  it("POSTs /images/generations and reads b64_json — no live network", async () => {
    const png = solidPng(4, 4, [9, 8, 7]);
    const fetchImpl: typeof fetch = async (url, init) => {
      expect(String(url)).toBe("https://api.x.ai/v1/images/generations");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer xai-test-key");
      const body = JSON.parse(String(init?.body));
      expect(body.n).toBe(4);
      expect(body.prompt).toContain("Scout");
      expect(JSON.stringify(body)).not.toContain("xai-test-key");
      return new Response(
        JSON.stringify({
          data: Array.from({ length: 4 }, () => ({ b64_json: png.toString("base64") })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const images = await generateAvatarImagesHttp(
      { prompt: "Scout", count: 4, provider: "xai", apiKey: "xai-test-key" },
      fetchImpl,
    );
    expect(images).toHaveLength(4);
    expect(images[0]!.bytes.equals(png)).toBe(true);
  });

  it("redacts the key from provider error text", async () => {
    const key = "xai-should-not-leak-in-errors";
    const fetchImpl: typeof fetch = async () =>
      new Response(`denied ${key}`, { status: 401, headers: { "content-type": "text/plain" } });
    await expect(
      generateAvatarImagesHttp({ prompt: "x", count: 4, provider: "xai", apiKey: key }, fetchImpl),
    ).rejects.toThrow(/\[redacted\]/);
  });
});

describe("collectAvatarHashes", () => {
  it("unions accepted + candidate hashes and ignores junk", () => {
    const keep = putBlob(Buffer.from("avatar-keep"));
    const extra = hashBytes(Buffer.from("not-stored-here"));
    const set = collectAvatarHashes([
      { avatarImageHash: keep, avatarCandidates: [extra, "nope"] },
      { avatarImageHash: "bad" },
    ]);
    expect(set.has(keep)).toBe(true);
    expect(set.has(extra)).toBe(true);
    expect(set.has("nope")).toBe(false);
  });
});
