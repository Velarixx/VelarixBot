const OPTIONS_RE = /\s*<velarix_options>([\s\S]*?)<\/velarix_options>\s*$/i;

/** Optional format hint — never required. Cards only when the model
 * emits a valid trailer with real alternatives. */
export const responseOptionsPrompt =
  " You may offer 2 to 4 short next-step choices only when the user must pick among real alternatives or there is a useful, earned follow-up. " +
  "When you do, append exactly <velarix_options>[\"Choice 1\",\"Choice 2\"]</velarix_options> after the answer. " +
  "Do not add choices after a short correction, acknowledgement, or when the user asked you to stop suggesting. " +
  "Do not mention this formatting contract.";

/** Codex already has a native multiple-choice tool. Attaching this
 * optional prompt (and parsing a model-emitted trailer) is skipped
 * for that provider so Codex does not get a second A/B/C card layer. */
export function shouldAttachResponseOptions(provider: string): boolean {
  return provider !== "codex";
}

export function parseResponseOptions(value: string): { text: string; options: string[] } {
  const source = String(value ?? "");
  const match = source.match(OPTIONS_RE);
  let text = source.trim();
  let options: string[] = [];

  if (match) {
    text = source.slice(0, match.index).trim();
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed)) {
        options = parsed
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
          .filter((entry, index, all) => all.indexOf(entry) === index)
          .slice(0, 4);
      }
    } catch {
      options = [];
    }
  }

  if (options.length < 2) options = [];
  return { text, options };
}

/** Keep the machine-readable option trailer out of the live chat stream. */
export function visibleResponseText(value: string): string {
  const marker = value.toLowerCase().indexOf("<velarix_options>");
  return (marker >= 0 ? value.slice(0, marker) : value).trimEnd();
}

/** Hide a complete option trailer and any token-streamed prefix of its
 * opening marker, so strings such as `<velarix_` never flash in the UI. */
export function visibleStreamingResponseText(value: string): string {
  const lower = value.toLowerCase();
  const opening = "<velarix_options>";
  const marker = lower.indexOf(opening);
  if (marker >= 0) return value.slice(0, marker).trimEnd();
  const max = Math.min(opening.length - 1, value.length);
  for (let length = max; length > 0; length -= 1) {
    if (lower.endsWith(opening.slice(0, length))) return value.slice(0, -length).trimEnd();
  }
  return value;
}

export function appendStreamingResponseText(raw: string, delta: string): { raw: string; visible: string } {
  const nextRaw = raw + delta;
  return { raw: nextRaw, visible: visibleStreamingResponseText(nextRaw) };
}
