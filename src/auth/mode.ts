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

type TrustedImportMeta = ImportMeta & {
  readonly env?: { readonly VITE_VELARIX_APP_MODE?: string };
};

export function trustedClientApplicationMode(
  meta: TrustedImportMeta = import.meta as TrustedImportMeta,
): ClientApplicationMode {
  return resolveClientApplicationMode(meta.env?.VITE_VELARIX_APP_MODE);
}
