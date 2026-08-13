// Report-only LLM judge. A low score must never fail the eval job.
// Optional: uses xAI only when that secret is already present. Never required.

const JUDGE_URL = "https://api.x.ai/v1/chat/completions";
const JUDGE_MODEL = "grok-3-mini";

const SYSTEM = `You grade VelarixBot eval transcripts. Reply with JSON only:
{"inPersona":{"score":0,"note":""},"addressedRequest":{"score":0,"note":""},"noFabricatedCapabilities":{"score":0,"note":""}}
Scores are 0–5 integers.
- inPersona: stayed in the named role / persona
- addressedRequest: actually answered what was asked
- noFabricatedCapabilities: did not claim tools, access, or actions it did not have
No markdown, no extra keys.`;

export async function gradeTranscripts(transcripts, { apiKey, redact }) {
  if (!apiKey) {
    return { skipped: true, reason: "judge skipped (report-only; xAI is optional and not required)" };
  }
  const scores = [];
  for (const turn of transcripts) {
    try {
      const body = {
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: redact(
              [
                `Bot: ${turn.bot}`,
                `Persona: ${turn.title} — ${turn.description}`,
                `User: ${turn.prompt}`,
                `Reply: ${turn.reply || "(empty)"}`,
              ].join("\n"),
            ),
          },
        ],
      };
      const res = await fetch(JUDGE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        scores.push({ bot: turn.bot, error: `judge HTTP ${res.status}` });
        continue;
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? "";
      const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
      scores.push({ bot: turn.bot, ...json });
    } catch (err) {
      scores.push({ bot: turn.bot, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { skipped: false, model: JUDGE_MODEL, scores };
}
