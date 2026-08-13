// OmniRouter — OpenAI-compatible chat completions (BYO key, write-only).
// Chat only: no MCP/tools on this driver. Point `url` at a self-hosted
// gateway (e.g. http://127.0.0.1:20128/v1) when you are not using the
// hosted omnirouters.com endpoint.
import { createOpenAICompatDriver } from "./openai-compat.ts";

const MODELS = {
  default: "gpt-4o-mini",
  options: [
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ],
};

export const OmniRouterDriver = createOpenAICompatDriver({
  driverKind: "omnirouter",
  displayName: "OmniRouter",
  defaultUrl: "https://omnirouters.com/v1",
  defaultApiKeyEnv: "OMNIROUTER_API_KEY",
  models: MODELS,
  generateTextModel: "gpt-4o-mini",
  missingKeyReason: (env) =>
    `no OmniRouter API key — add {"omnirouter":{"key":"…"}} to ~/.velarixbot/config.json or set ${env}`,
});
