import { describe, expect, it } from "vitest";

import { fetchPage, htmlToText, isPublicHttpUrl, webSearch } from "./web.ts";

describe("isPublicHttpUrl", () => {
  it("accepts public http(s) and rejects private / local / metadata", () => {
    expect(isPublicHttpUrl("https://example.com/a")).toBe(true);
    expect(isPublicHttpUrl("http://example.org")).toBe(true);
    expect(isPublicHttpUrl("ftp://example.com")).toBe(false);
    expect(isPublicHttpUrl("https://localhost/x")).toBe(false);
    expect(isPublicHttpUrl("http://127.0.0.1/x")).toBe(false);
    expect(isPublicHttpUrl("http://10.0.0.4/x")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.1.9/x")).toBe(false);
    expect(isPublicHttpUrl("http://172.16.0.2/x")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isPublicHttpUrl("http://metadata.google.internal/")).toBe(false);
    expect(isPublicHttpUrl("http://box.local/")).toBe(false);
    expect(isPublicHttpUrl("not a url")).toBe(false);
  });
});

describe("htmlToText", () => {
  it("strips tags and scripts and caps length", () => {
    expect(htmlToText("<html><script>alert(1)</script><p>Hello &amp; hi</p></html>")).toBe("Hello & hi");
    expect(htmlToText("<p>abc</p>", 2)).toBe("ab…");
  });
});

describe("webSearch", () => {
  it("needs a query", async () => {
    await expect(webSearch("  ", async () => { throw new Error("fetch"); })).rejects.toThrow(/query/);
  });

  it("formats DuckDuckGo instant-answer JSON via injected fetch", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      expect(String(url)).toContain("duckduckgo.com");
      expect(String(url)).toContain("Velarix");
      return new Response(
        JSON.stringify({
          Heading: "Velarix",
          AbstractText: "A desktop agent harness.",
          AbstractURL: "https://example.com/velarix",
          RelatedTopics: [{ Text: "Related one" }, { Topics: [{ Text: "Nested" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const text = await webSearch("Velarix", fetchImpl);
    expect(text).toContain("Search: Velarix");
    expect(text).toContain("A desktop agent harness.");
    expect(text).toContain("https://example.com/velarix");
    expect(text).toContain("- Related one");
    expect(text).toContain("- Nested");
  });

  it("says so when there are no instant results", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    expect(await webSearch("zzzz-no-hits", fetchImpl)).toMatch(/No instant results/);
  });
});

describe("fetchPage", () => {
  it("refuses private URLs without fetching", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("nope");
    };
    await expect(fetchPage("http://127.0.0.1/secret", fetchImpl)).rejects.toThrow(/public http/);
    expect(called).toBe(false);
  });

  it("returns readable text from HTML via injected fetch", async () => {
    const fetchImpl: typeof fetch = async (url) => {
      expect(String(url)).toBe("https://example.com/page");
      return new Response("<html><h1>Title</h1><p>Body text</p></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const text = await fetchPage("https://example.com/page", fetchImpl);
    expect(text).toContain("Fetched https://example.com/page");
    expect(text).toContain("Title");
    expect(text).toContain("Body text");
  });
});
