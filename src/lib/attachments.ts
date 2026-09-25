// Composer chips: drop/paste → removable attachments. Paths stay local;
// the server expands folders and refuses ~/.velarixbot/config.json keys.
export interface AttachmentChip {
  id: string;
  name: string;
  path: string;
  mime?: string;
}

export interface DroppedFile {
  name: string;
  path?: string;
  type?: string;
}

export function chipFromDroppedFile(file: DroppedFile, id: string): AttachmentChip | null {
  const path = (file.path || "").trim();
  if (!path) return null;
  const name = file.name?.trim() || path.split(/[/\\]/).pop() || path;
  const mime = file.type?.trim() || undefined;
  return { id, name, path, mime };
}

export async function prepareDroppedFiles(
  files: File[],
  bridge: Pick<NonNullable<Window["ogb"]>, "attachmentPath" | "saveClipboardImage"> | undefined,
): Promise<{ files: DroppedFile[]; errors: string[] }> {
  const accepted: DroppedFile[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const path = bridge?.attachmentPath?.(file);
      if (path) { accepted.push({ name: file.name, path, type: file.type }); continue; }
      if (!bridge?.saveClipboardImage) throw new Error("Open the desktop app to attach local files.");
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("This file has no readable local path. Use Attach files instead.");
      if (file.size > 25 * 1024 * 1024) throw new Error("Images must be 25 MB or smaller.");
      const saved = await bridge.saveClipboardImage({ bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type });
      accepted.push({ ...saved, type: file.type });
    } catch (error) { errors.push(`${file.name || "Image"}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { files: accepted, errors };
}

export function sendPayload(
  text: string,
  chips: AttachmentChip[],
): { text: string; attachments: Array<{ path: string; mime?: string }> } {
  return {
    text: text.trim(),
    attachments: chips.map((c) => ({ path: c.path, ...(c.mime ? { mime: c.mime } : {}) })),
  };
}
