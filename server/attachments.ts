// Local attachment paths for sendTurn. Drop is the permission gesture;
// we never upload, never read ~/.velarixbot/config.json, and never put
// file bytes on argv.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const MAX_FILES = 40;
const MAX_DEPTH = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function isSecretConfigPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    /\/\.velarixbot\/config\.json$/.test(norm) ||
    /\/\.openmausbot\/config\.json$/.test(norm) ||
    /\/\.opengrokbot\/config\.json$/.test(norm)
  );
}

export function expandAttachmentPaths(
  paths: string[],
  { maxFiles = MAX_FILES, maxDepth = MAX_DEPTH } = {},
): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    if (out.length >= maxFiles) return;
    if (isSecretConfigPath(p)) return;
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isFile()) {
      out.push(p);
      return;
    }
    if (!st.isDirectory() || depth > maxDepth) return;
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= maxFiles) return;
      walk(join(p, name), depth + 1);
    }
  };
  for (const p of paths) {
    if (typeof p !== "string" || !p.trim()) continue;
    walk(p.trim(), 0);
    if (out.length >= maxFiles) break;
  }
  return out;
}

export function attachmentPathRefs(text: string, paths: string[]): string {
  const files = paths.filter((p) => !isSecretConfigPath(p));
  if (!files.length) return text;
  const block = `Attached files:\n${files.map((p) => `- ${p}`).join("\n")}`;
  return text.trim() ? `${text.trim()}\n\n${block}` : block;
}

export interface ImageBytes {
  path: string;
  mime: string;
  data: string;
}

function imageMediaType(item: { path: string; mime?: string }): string | undefined {
  return item.mime && item.mime.startsWith("image/") ? item.mime : IMAGE_EXT[extname(item.path).toLowerCase()];
}

/** Readable local image files as bytes. Secrets and non-images are skipped.
 * Callers must not invent vision for files this returns empty for. */
export function readImageBytes(paths: Array<{ path: string; mime?: string }>): ImageBytes[] {
  const out: ImageBytes[] = [];
  for (const item of paths) {
    if (isSecretConfigPath(item.path)) continue;
    const mime = imageMediaType(item);
    if (!mime) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(item.path);
    } catch {
      continue;
    }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    out.push({ path: item.path, mime, data: buf.toString("base64") });
  }
  return out;
}

export function claudeImageBlocks(
  paths: Array<{ path: string; mime?: string }>,
): Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> {
  return readImageBytes(paths).map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mime, data: img.data },
  }));
}

/** ACP session/prompt image content. Only send when the agent advertised
 * promptCapabilities.image — otherwise keep path refs and do not fake vision. */
export function acpImageBlocks(
  paths: Array<{ path: string; mime?: string }>,
): Array<{ type: "image"; mimeType: string; data: string }> {
  return readImageBytes(paths).map((img) => ({ type: "image", mimeType: img.mime, data: img.data }));
}

export type CodexImageInput = { type: "image"; url: string } | { type: "localImage"; path: string };

/** Codex turn/start image items: inline bytes as a data URL when the file
 * is readable, else a localImage path ref. Non-images stay in text refs. */
export function codexImageInput(paths: Array<{ path: string; mime?: string }>): CodexImageInput[] {
  const byPath = new Map(readImageBytes(paths).map((img) => [img.path, img]));
  const out: CodexImageInput[] = [];
  for (const item of paths) {
    if (isSecretConfigPath(item.path)) continue;
    if (!imageMediaType(item)) continue;
    const bytes = byPath.get(item.path);
    if (bytes) {
      out.push({ type: "image", url: `data:${bytes.mime};base64,${bytes.data}` });
    } else {
      out.push({ type: "localImage", path: item.path });
    }
  }
  return out;
}

/** True when an ACP initialize result advertises image prompts. Missing
 * capability means path refs only — do not send image blocks. */
export function agentAcceptsImagePrompts(init: unknown): boolean {
  if (!init || typeof init !== "object") return false;
  const o = init as { agentCapabilities?: { promptCapabilities?: { image?: unknown } }; promptCapabilities?: { image?: unknown } };
  return o.agentCapabilities?.promptCapabilities?.image === true || o.promptCapabilities?.image === true;
}
