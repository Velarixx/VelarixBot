export type BotState = "IDLE" | "RUNNING" | "DONE" | "BLOCKED" | "NEEDS_INPUT";

export interface Usage {
  input: number;
  output: number;
  cost: number | null;
}

export function stateLabel(state: BotState): string {
  return state === "NEEDS_INPUT" ? "Needs input" : state[0] + state.slice(1).toLowerCase();
}

export function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}k`;
  return String(tokens);
}

export function formatUsageCost(cost: number | null): string {
  if (cost === null) return "cost unavailable";
  if (cost === 0 || cost >= 0.1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(3)}`;
}

export const ONBOARDING_KEY = "velarixbot:onboarding-complete:v1";
const LEGACY_ONBOARDING_KEY = "openmausbot:onboarding-complete:v1";

export function onboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "true" || localStorage.getItem(LEGACY_ONBOARDING_KEY) === "true";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, "true");
  } catch {
    // The app remains usable even when storage is unavailable.
  }
}
