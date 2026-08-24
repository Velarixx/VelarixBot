// Remote URL download policy. Default-deny for non-http(s) and
// loopback / link-local / private targets. Host allowlists are optional.
// Never follow a redirect onto a blocked address. Secrets in userinfo
// never appear in errors.

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type RemoteUrlLookup = (hostname: string) => Promise<{ address: string }>;

export type RemoteUrlDecision = { ok: true; href: string } | { ok: false; reason: string };

export interface RemoteUrlPolicyOptions {
  allowHostnames?: string[];
  allowLinkLocal?: boolean;
}

export interface RemoteDownloadOptions extends RemoteUrlPolicyOptions {
  fetchImpl?: typeof fetch;
  lookup?: RemoteUrlLookup;
  maxBytes?: number;
  maxRedirects?: number;
}

export type RemoteDownloadResult =
  | { ok: true; bytes: Uint8Array; mime?: string; href: string }
  | { ok: false; reason: string };

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.internal",
]);

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

function unwrapIpv6Host(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function normalizeHost(host: string): string {
  return unwrapIpv6Host(host.trim().toLowerCase().replace(/\.$/, ""));
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    return ipv4Parts(tail) ? tail : null;
  }
  return null;
}

function isBlockedIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return true;
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const mapped = mappedIpv4(lower);
  return mapped ? isBlockedIpv4(mapped) : false;
}

export function isBlockedLiteralAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return false;
}

function safeHref(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  return copy.href;
}

function hostAllowed(hostname: string, allowHostnames?: string[]): boolean {
  if (!allowHostnames) return true;
  const want = normalizeHost(hostname);
  return allowHostnames.some((entry) => normalizeHost(entry) === want);
}

/** Sync policy for a remote attachment URL. Does not fetch. */
export function assessRemoteAttachmentUrl(raw: string, opts: RemoteUrlPolicyOptions = {}): RemoteUrlDecision {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "remote attachment URL is invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `remote attachment URL scheme ${url.protocol} is not allowed` };
  }
  const hostname = normalizeHost(url.hostname);
  if (!hostname) return { ok: false, reason: "remote attachment URL host is empty" };
  if (!hostAllowed(hostname, opts.allowHostnames)) {
    return { ok: false, reason: "remote attachment host is not allowlisted" };
  }
  if (BLOCKED_HOSTS.has(hostname) && !opts.allowLinkLocal) {
    return { ok: false, reason: "remote attachment URL targets a blocked host" };
  }
  if (isIP(hostname) && isBlockedLiteralAddress(hostname) && !opts.allowLinkLocal) {
    return { ok: false, reason: "remote attachment URL targets a link-local or private address" };
  }
  return { ok: true, href: safeHref(url) };
}

async function resolveAndCheck(
  hostname: string,
  lookup: RemoteUrlLookup,
  allowLinkLocal: boolean,
): Promise<RemoteUrlDecision> {
  if (isIP(hostname)) {
    if (isBlockedLiteralAddress(hostname) && !allowLinkLocal) {
      return { ok: false, reason: "remote attachment URL targets a link-local or private address" };
    }
    return { ok: true, href: hostname };
  }
  if (BLOCKED_HOSTS.has(normalizeHost(hostname)) && !allowLinkLocal) {
    return { ok: false, reason: "remote attachment URL targets a blocked host" };
  }
  let resolved: { address: string };
  try {
    resolved = await lookup(hostname);
  } catch {
    return { ok: false, reason: "remote attachment host could not be resolved" };
  }
  if (isBlockedLiteralAddress(resolved.address) && !allowLinkLocal) {
    return { ok: false, reason: "remote attachment URL resolved to a link-local or private address" };
  }
  return { ok: true, href: hostname };
}

function redirectUrl(current: URL, location: string): URL | null {
  try {
    return new URL(location, current);
  } catch {
    return null;
  }
}

/**
 * Download a remote attachment after the URL and resolved address pass policy.
 * Fetch and DNS are injectable so tests never hit the network.
 */
export async function downloadRemoteAttachment(raw: string, opts: RemoteDownloadOptions = {}): Promise<RemoteDownloadResult> {
  const first = assessRemoteAttachmentUrl(raw, opts);
  if (!first.ok) return first;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? ((hostname: string) => dnsLookup(hostname).then((row) => ({ address: row.address })));
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowLinkLocal = opts.allowLinkLocal === true;

  let current = new URL(first.href);
  for (let hops = 0; hops <= maxRedirects; hops++) {
    const assessed = assessRemoteAttachmentUrl(current.href, opts);
    if (!assessed.ok) return assessed;
    const resolved = await resolveAndCheck(normalizeHost(current.hostname), lookup, allowLinkLocal);
    if (!resolved.ok) return resolved;
    let response: Response;
    try {
      response = await fetchImpl(current, { method: "GET", redirect: "manual" });
    } catch {
      return { ok: false, reason: "remote attachment download failed" };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "remote attachment redirect is missing a location" };
      const next = redirectUrl(current, location);
      if (!next) return { ok: false, reason: "remote attachment redirect is invalid" };
      current = next;
      continue;
    }
    if (!response.ok) return { ok: false, reason: `remote attachment download returned HTTP ${response.status}` };
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return { ok: false, reason: `remote attachment exceeds the ${maxBytes} byte download limit` };
    }
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
    return { ok: true, bytes: buf, href: safeHref(current), ...(mime ? { mime } : {}) };
  }
  return { ok: false, reason: "remote attachment redirected too many times" };
}
