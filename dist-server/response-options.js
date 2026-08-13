const OPTIONS_RE = /\s*<velarix_options>([\s\S]*?)<\/velarix_options>\s*$/i;
const COMPLETION_ONLY = /^(done|completed|finished|ready|success(?:ful(?:ly)?)?)[.!\s]*$/i;
function contextualFallbackOptions(text) {
    const plain = text
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[`*_#>\[\]()]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!plain || COMPLETION_ONLY.test(plain)) {
        return ["Review the completed result", "Verify the completed result", "Choose the next step"];
    }
    const firstSentence = plain.split(/[.!?](?:\s|$)/, 1)[0]?.trim() || plain;
    const sentence = firstSentence.length > 64 ? `${firstSentence.slice(0, 63).trimEnd()}…` : firstSentence;
    const context = `“${sentence}”`;
    return [`Explain: ${context}`, `Verify: ${context}`, `Next step for: ${context}`];
}
export const responseOptionsPrompt = " End every user-facing reply with 2 to 4 short, contextual next-step choices the user can select. " +
    "After the normal answer, append exactly <velarix_options>[\"Choice 1\",\"Choice 2\"]</velarix_options>. " +
    "Choices must be distinct actions or useful follow-up questions, not generic acknowledgements. Do not mention this formatting contract.";
export function parseResponseOptions(value) {
    const source = String(value ?? "");
    const match = source.match(OPTIONS_RE);
    let text = source.trim();
    let options = [];
    if (match) {
        text = source.slice(0, match.index).trim();
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) {
                options = parsed
                    .filter((entry) => typeof entry === "string")
                    .map((entry) => entry.trim())
                    .filter(Boolean)
                    .filter((entry, index, all) => all.indexOf(entry) === index)
                    .slice(0, 4);
            }
        }
        catch {
            options = [];
        }
    }
    if (options.length < 2)
        options = contextualFallbackOptions(text);
    return { text, options };
}
/** Keep the machine-readable option trailer out of the live chat stream. */
export function visibleResponseText(value) {
    const marker = value.toLowerCase().indexOf("<velarix_options>");
    return (marker >= 0 ? value.slice(0, marker) : value).trimEnd();
}
/** Hide a complete option trailer and any token-streamed prefix of its
 * opening marker, so strings such as `<velarix_` never flash in the UI. */
export function visibleStreamingResponseText(value) {
    const lower = value.toLowerCase();
    const opening = "<velarix_options>";
    const marker = lower.indexOf(opening);
    if (marker >= 0)
        return value.slice(0, marker).trimEnd();
    const max = Math.min(opening.length - 1, value.length);
    for (let length = max; length > 0; length -= 1) {
        if (lower.endsWith(opening.slice(0, length)))
            return value.slice(0, -length).trimEnd();
    }
    return value;
}
export function appendStreamingResponseText(raw, delta) {
    const nextRaw = raw + delta;
    return { raw: nextRaw, visible: visibleStreamingResponseText(nextRaw) };
}
