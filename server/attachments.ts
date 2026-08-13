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

export function claudeImageBlocks(
  paths: Array<{ path: string; mime?: string }>,
): Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> {
  const blocks: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }> = [];
  for (const item of paths) {
    if (isSecretConfigPath(item.path)) continue;
    const media = item.mime && item.mime.startsWith("image/") ? item.mime : IMAGE_EXT[extname(item.path).toLowerCase()];
    if (!media) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(item.path);
    } catch {
      continue;
    }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    blocks.push({ type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } });
  }
  return blocks;
}
