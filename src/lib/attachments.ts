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
  const path = (file.path || file.name || "").trim();
  if (!path) return null;
  const name = file.name?.trim() || path.split(/[/\\]/).pop() || path;
  const mime = file.type?.trim() || undefined;
  return { id, name, path, mime };
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
