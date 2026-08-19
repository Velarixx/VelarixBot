/// <reference types="vite/client" />

export type ClientApplicationMode = "desktop" | "saas" | "invalid";

/**
 * The renderer mode is build/runtime composition, never browser state.
 * Missing configuration keeps the established desktop application. Unknown
 * configuration is represented explicitly so the root can render without
 * mounting either product or authentication transports.
 */
export function resolveClientApplicationMode(value: unknown): ClientApplicationMode {
  if (value === undefined || value === null || value === "" || value === "desktop") {
    return "desktop";
  }
  if (value === "saas") return "saas";
  return "invalid";
}

export function trustedClientApplicationMode(
  value: unknown = import.meta.env.VITE_VELARIX_APP_MODE,
): ClientApplicationMode {
  return resolveClientApplicationMode(value);
}
