// Public-web helpers for CoS tools. No API key. Secrets never travel here.
// Tests inject fetch — no live network in the suite.

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|metadata\.google\.internal)$/i;

export function isPublicHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (PRIVATE_HOST.test(url.hostname)) return false;
    if (url.hostname.endsWith(".local")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Strip tags / scripts to plain text. Caps length so the model isn't flooded. */
export function htmlToText(html: string, max = 8_000): string {
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

type FetchFn = typeof fetch;

function ddgTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as { Text?: unknown; Topics?: unknown };
    if (typeof t.Text === "string" && t.Text.trim()) out.push(t.Text.trim());
    out.push(...ddgTopics(t.Topics));
  }
  return out;
}

export async function webSearch(query: string, fetchImpl: FetchFn = fetch): Promise<string> {
  const q = query.trim();
  if (!q) throw new Error("web_search needs a query");
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(12_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`search failed (HTTP ${res.status})`);
  const json = (await res.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    Heading?: string;
    RelatedTopics?: unknown;
    Answer?: string;
  };
  const lines: string[] = [];
  if (json.Heading) lines.push(json.Heading);
  if (json.AbstractText) lines.push(json.AbstractText);
  if (json.AbstractURL) lines.push(json.AbstractURL);
  if (json.Answer) lines.push(json.Answer);
  for (const topic of ddgTopics(json.RelatedTopics).slice(0, 8)) lines.push(`- ${topic}`);
  if (!lines.length) return `No instant results for ${q}. Try fetch_page on a specific URL.`;
  return `Search: ${q}\n${lines.join("\n")}`;
}

export async function fetchPage(rawUrl: string, fetchImpl: FetchFn = fetch): Promise<string> {
  const url = rawUrl.trim();
  if (!isPublicHttpUrl(url)) throw new Error("fetch_page only accepts public http(s) URLs");
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`fetch failed (HTTP ${res.status})`);
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  const body = await res.text();
  if (ctype.includes("json") || ctype.startsWith("text/plain")) {
    const text = body.trim();
    return text.length > 8_000 ? `${text.slice(0, 8_000)}…` : text;
  }
  const text = htmlToText(body);
  if (!text) throw new Error("page had no readable text");
  return `Fetched ${url}\n${text}`;
}
