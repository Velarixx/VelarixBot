import { describe, expect, it } from "vitest";
import {
  compareVersions,
  DEV_NOOP_MESSAGE,
  newestNewerRelease,
  NO_TOKEN_MESSAGE,
  pickAsset,
  pickChecksumAsset,
  publicState,
  readGithubToken,
  tokenConfigured,
} from "../electron/update-feed.mjs";

const feed = [
  {
    tag_name: "v0.1.12",
    assets: [{ name: "VelarixBot-0.1.12-arm64.dmg", url: "https://api.github.com/assets/12" }],
  },
  {
    tag_name: "v0.1.14",
    assets: [
      { name: "VelarixBot-0.1.14-arm64.dmg", url: "https://api.github.com/assets/14a" },
      { name: "VelarixBot-0.1.14-x64.dmg", url: "https://api.github.com/assets/14x" },
      { name: "VelarixBot-Setup-0.1.14-x64.exe", url: "https://api.github.com/assets/14w" },
    ],
  },
];

describe("update feed", () => {
  it("compares versions and picks a newer GitHub release + platform asset", () => {
    expect(compareVersions("0.1.13", "v0.1.13")).toBe(0);
    expect(compareVersions("0.1.14", "0.1.13")).toBeGreaterThan(0);
    expect(compareVersions("0.1.13", "0.1.14")).toBeLessThan(0);
    const newer = newestNewerRelease(feed, "0.1.13");
    expect(newer?.tag_name).toBe("v0.1.14");
    expect(newestNewerRelease(feed, "0.1.14")).toBeNull();
    expect(pickAsset(newer, "darwin", "arm64")?.name).toContain("arm64.dmg");
    expect(pickAsset(newer, "darwin", "x64")?.name).toContain("x64.dmg");
    expect(pickAsset(newer, "win32", "x64")?.name).toMatch(/\.exe$/);
    expect(pickChecksumAsset({ assets: [{ name: "SHA256SUMS.txt", url: "https://api.github.com/assets/sums" }] })?.name).toBe(
      "SHA256SUMS.txt",
    );
    expect(pickChecksumAsset(newer)).toBeNull();
  });

  it("compares prerelease suffixes numerically so rc.10 is newer than rc.2", () => {
    expect(compareVersions("0.1.14-rc.10", "0.1.14-rc.2")).toBeGreaterThan(0);
    expect(compareVersions("0.1.14-rc.2", "0.1.14-rc.10")).toBeLessThan(0);
    expect(compareVersions("v0.1.14-rc.10", "0.1.14-rc.10")).toBe(0);
    expect(compareVersions("0.1.14", "0.1.14-rc.10")).toBeGreaterThan(0);
    expect(compareVersions("0.1.14-rc.10", "0.1.13-rc.99")).toBeGreaterThan(0);
    expect(newestNewerRelease(
      [{ tag_name: "v0.1.14-rc.2" }, { tag_name: "v0.1.14-rc.10" }],
      "0.1.14-rc.9",
    )?.tag_name).toBe("v0.1.14-rc.10");
  });

  it("ignores draft releases so they are never offered as an update", () => {
    const draftNewest = [
      { tag_name: "v0.2.0", draft: true, assets: [{ name: "VelarixBot-0.2.0-arm64.dmg" }] },
      { tag_name: "v0.1.14", draft: false, assets: [{ name: "VelarixBot-0.1.14-arm64.dmg" }] },
    ];
    expect(newestNewerRelease(draftNewest, "0.1.13")?.tag_name).toBe("v0.1.14");
    expect(newestNewerRelease([{ tag_name: "v0.2.0", draft: true }], "0.1.13")).toBeNull();
    expect(newestNewerRelease([{ tag_name: "v0.2.0", draft: false }], "0.1.13")?.tag_name).toBe("v0.2.0");
  });

  it("treats a missing token as an honest no-token branch", () => {
    expect(tokenConfigured("")).toBe(false);
    expect(tokenConfigured("  ")).toBe(false);
    expect(tokenConfigured("ghp_not_logged")).toBe(true);
    expect(NO_TOKEN_MESSAGE).toMatch(/GitHub token/i);
    expect(DEV_NOOP_MESSAGE).toMatch(/packaged/i);
  });

  it("reads the token write-only and never puts it on public updater state", () => {
    const token = "ghp_secret_snapshot_token";
    expect(readGithubToken({ GITHUB_TOKEN: "env_tok" }, JSON.stringify({ github: { token } }))).toBe(token);
    expect(readGithubToken({ GH_TOKEN: "env_only" }, "{")).toBe("env_only");
    const state = publicState({
      status: "error",
      message: NO_TOKEN_MESSAGE,
      tokenConfigured: false,
      downloadToken: token,
    });
    expect(state.tokenConfigured).toBe(false);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state)).not.toContain("downloadToken");
  });
});
