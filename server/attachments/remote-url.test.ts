import { describe, expect, it } from "vitest";

import { assessRemoteAttachmentUrl, downloadRemoteAttachment } from "./remote-url.ts";

describe("remote attachment URL policy", () => {
  it("denies non-http(s) and link-local targets unless already allowed", () => {
    expect(assessRemoteAttachmentUrl("file:///etc/passwd").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("ftp://files.example/a.bin").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("http://127.0.0.1/secret").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("http://[::1]/").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("http://192.168.1.9/a").ok).toBe(false);
    expect(assessRemoteAttachmentUrl("http://localhost/a").ok).toBe(false);

    const loopback = assessRemoteAttachmentUrl("http://127.0.0.1/ok", { allowLinkLocal: true });
    expect(loopback).toEqual({ ok: true, href: "http://127.0.0.1/ok" });

    const denied = assessRemoteAttachmentUrl("https://cdn.example/a.png", { allowHostnames: [] });
    expect(denied.ok).toBe(false);
    const allowed = assessRemoteAttachmentUrl("https://cdn.example/a.png", { allowHostnames: ["cdn.example"] });
    expect(allowed).toEqual({ ok: true, href: "https://cdn.example/a.png" });
  });

  it("never echoes URL userinfo and refuses SSRF via DNS or redirect", async () => {
    const canary = ["fake", "remote", "canary", Date.now().toString(36)].join("-");
    const assessed = assessRemoteAttachmentUrl(`https://user:${canary}@cdn.example/a.png`, {
      allowHostnames: ["cdn.example"],
    });
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) throw new Error("expected allow");
    expect(assessed.href).toBe("https://cdn.example/a.png");
    expect(JSON.stringify(assessed)).not.toContain(canary);

    const resolvedPrivate = await downloadRemoteAttachment("https://evil.example/a.png", {
      allowHostnames: ["evil.example"],
      lookup: async () => ({ address: "127.0.0.1" }),
      fetchImpl: async () => new Response("nope"),
    });
    expect(resolvedPrivate.ok).toBe(false);
    if (resolvedPrivate.ok) throw new Error("expected deny");
    expect(resolvedPrivate.reason).toMatch(/link-local or private/);

    const redirected = await downloadRemoteAttachment("https://cdn.example/a.png", {
      allowHostnames: ["cdn.example"],
      lookup: async (host) => ({ address: host === "cdn.example" ? "93.184.216.34" : "127.0.0.1" }),
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }),
    });
    expect(redirected.ok).toBe(false);
    if (redirected.ok) throw new Error("expected deny");
    expect(redirected.reason).toMatch(/link-local|private|blocked|allowlisted/);

    const ok = await downloadRemoteAttachment("https://cdn.example/a.png", {
      allowHostnames: ["cdn.example"],
      lookup: async () => ({ address: "93.184.216.34" }),
      fetchImpl: async () => new Response(Uint8Array.from([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    });
    expect(ok).toMatchObject({ ok: true, mime: "image/png", href: "https://cdn.example/a.png" });
    if (!ok.ok) throw new Error("expected download");
    expect(Array.from(ok.bytes)).toEqual([1, 2, 3]);
  });
});
