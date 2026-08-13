// OpenRouter — OpenAI-compatible chat completions (BYO key, write-only).
// Chat only: no MCP/tools on this driver. Custom base URL via instance config.
import { createOpenAICompatDriver } from "./openai-compat.ts";

const MODELS = {
  default: "openai/gpt-4o-mini",
  options: [
    { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
    { id: "openai/gpt-4o", label: "GPT-4o" },
    { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
    { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B" },
  ],
};

export const OpenRouterDriver = createOpenAICompatDriver({
  driverKind: "openrouter",
  displayName: "OpenRouter",
  defaultUrl: "https://openrouter.ai/api/v1",
  defaultApiKeyEnv: "OPENROUTER_API_KEY",
  models: MODELS,
  extraHeaders: {
    "HTTP-Referer": "https://github.com/Velarixx/VelarixBot",
    "X-Title": "VelarixBot",
  },
  generateTextModel: "openai/gpt-4o-mini",
  missingKeyReason: (env) =>
    `no OpenRouter API key — add {"openrouter":{"key":"sk-or-…"}} to ~/.velarixbot/config.json or set ${env}`,
});
