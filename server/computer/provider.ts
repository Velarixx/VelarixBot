// ComputerProvider SPI (P1.1) — the seam that keeps the harness vendor-
// neutral about where a bot's computer lives. bot.computer is a BINDING to
// one of these providers ("off" | "local" | a provider id like "box"), not
// an enum that hardcodes a vendor. First-party providers: local (core,
// always registered, approval-gated), box (bundled but optional — removable
// via config), fake (in-memory, powers the conformance suite every provider
// must pass).
//
// Shape notes (adapted from the sandbox-provider pattern, not copied):
// provision / execute→AsyncIterable / connectScreen / suspend / destroy are
// the lifecycle core; screenshot / readFile / mcpIntegration are the product
// surfaces the panel and turn dispatch need. Every operation is gated by
// DECLARED capabilities — an undeclared operation must reject with the
// canonical unsupported error (conformance-enforced), never hang or lie.

export interface ComputerCapabilities {
  /** execute() streams shell output from the computer. */
  exec: boolean;
  /** screenshot() captures the screen server-side (panel + screen-in-chat). */
  screenshot: boolean;
  /** readFile() reads a file back from the computer (attach_to_chat). */
  files: boolean;
  /** connectScreen() mints an openable desktop URL. */
  desktopUrl: boolean;
  /** suspend() parks the machine (billing pauses, disk survives). */
  suspend: boolean;
  /** destroy() permanently removes the machine. */
  destroy: boolean;
  /** mcpIntegration() builds a computer-tools MCP spawn contract for agent CLIs. */
  mcp: boolean;
}

export interface ComputerMachine {
  id: string;
  state: string;
  desktopAvailable?: boolean | null;
}

/** Cheap probe — MUST resolve, never reject. `configured: false` means the
 * provider cannot act yet (missing token / daemon) and `reason` says why. */
export interface ComputerStatus {
  configured: boolean;
  reason?: string;
  machine: ComputerMachine | null;
}

export interface ProvisionResult {
  machineId: string;
  machineName?: string;
  reused: boolean;
  state: string | null;
  joinUrl?: string | null;
}

export type ExecuteEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; exitCode: number | null };

export type ScreenConnection =
  | { kind: "url"; url: string; state?: string | null }
  /** The screen IS this machine's own display (local provider) — frames
   * come from the Electron shell, there is nothing to open. */
  | { kind: "local" };

/** A browser-safe rendered desktop frame. Unlike ScreenConnection, this
 * boundary cannot carry a URL, credential, provider response, or identifier.
 * SaaS composition may relay only these encoded image bytes. */
export interface ComputerViewerFrame {
  format: "png" | "jpeg";
  data: Uint8Array;
}

/** Server-side viewer connection. The provider must resolve only once the
 * first renderable frame is available; later frames keep the view live until
 * the supplied AbortSignal closes it. */
export interface ComputerViewerConnection {
  initialFrame: ComputerViewerFrame;
  frames: AsyncIterable<ComputerViewerFrame>;
}

/** MCP stdio spawn contract for mounting the computer tools on an agent
 * CLI. Built entirely by the provider — secrets ride env, NEVER argv. */
export interface ComputerMcpSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ComputerProvider {
  /** Binding id — what bot.computer stores (config key in computer.providers). */
  readonly id: string;
  /** Provider kind slug ("box" | "local" | "fake" | …). */
  readonly kind: string;
  readonly displayName: string;
  readonly capabilities: ComputerCapabilities;
  /** System-prompt line appended when this provider's tools are mounted on
   * a turn. Empty string = no prompt. */
  readonly turnPrompt: string;
  status(botId: string): Promise<ComputerStatus>;
  /** Find-or-create the bot's machine and make it ready. Idempotent. */
  provision(bot: { id: string; name: string }): Promise<ProvisionResult>;
  execute(botId: string, command: string, opts?: { timeoutMs?: number }): AsyncIterable<ExecuteEvent>;
  /** Fresh screen connection — cloud desktops mint a NEW url every call
   * (stream tokens rotate; never persist one). */
  connectScreen(botId: string): Promise<ScreenConnection>;
  /** Optional SaaS-safe seam, keyed by the durable tenant machine binding.
   * Existing desktop providers remain compatible through connectScreen(). */
  openViewer?(
    machineId: string,
    options: { signal: AbortSignal },
  ): Promise<ComputerViewerConnection>;
  suspend(botId: string): Promise<void>;
  destroy(botId: string): Promise<void>;
  screenshot(botId: string): Promise<{ png: string; format: "png" | "jpeg" }>;
  /** Read a file as base64. Paths must be absolute (assertAbsolutePath). */
  readFile(botId: string, path: string): Promise<{ content: string; path: string }>;
  /** Spawn contract mounting the computer tools for a turn, or null when no
   * machine/daemon exists yet. `machineId` is a lookup hint when the caller
   * already resolved the machine. */
  mcpIntegration(botId: string, opts?: { machineId?: string }): Promise<ComputerMcpSpawn | null>;
}

// ── provider factory (mirrors the driver SPI discipline) ────────────────
// decodeConfig THROWS on invalid config; create REJECTS (never sync-throws);
// the registry downgrades both to an unavailable shadow provider.
export interface ComputerProviderCreateInput<Config> {
  id: string;
  config: Config;
  /** Live AppConfig reference — token reads stay fresh across config saves
   * (the composition root mutates the same object in place). */
  appConfig: import("../config.ts").AppConfig;
}

export interface ComputerProviderFactory<Config = unknown> {
  readonly kind: string;
  readonly metadata: { displayName: string };
  decodeConfig(raw: unknown): Config;
  create(input: ComputerProviderCreateInput<Config>): Promise<ComputerProvider>;
}

export type AnyComputerProviderFactory = ComputerProviderFactory<any>;

/** Canonicalize a bot.computer binding value. "cloud" is the legacy enum
 * value and aliases the bundled Box binding; empty/non-string means off.
 * Purely syntactic — the registry decides whether the id is registered. */
export function normalizeComputerBinding(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) return "off";
  return s === "cloud" ? "box" : s;
}

/** Canonical rejection for an operation the provider does not declare. */
export function unsupportedOperation(kind: string, op: string): Error {
  return Object.assign(new Error(`the ${kind} computer provider does not support ${op}`), {
    code: "computer_unsupported",
  });
}

export function isUnsupportedOperation(e: unknown): boolean {
  return Boolean(e && typeof e === "object" && (e as { code?: string }).code === "computer_unsupported");
}

/** Shared path rule for readFile — reject before any transport is touched. */
export function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/") || path.includes("..")) throw new Error("path must be absolute");
}
