// The narrow bridge the Electron preload exposes. Absent in the browser.
export {};

declare global {
  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      screenFrame(): Promise<string | null>;
      speechStart(): Promise<void>;
      speechStop(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null }) => void): () => void;
      /** {mic} TCC status: granted|denied|not-determined|unknown. Screen
       * status is deliberately absent — macOS 15+ caches it per-process,
       * so it lies for the whole session after a grant. */
      permStatus(): Promise<{ mic: string }>;
      /** Triggers the macOS microphone prompt; resolves true when granted. */
      permRequestMic(): Promise<boolean>;
      /** Opens System Settings on a privacy pane: mic|screen|speech. */
      permOpenSettings(pane: "mic" | "screen" | "speech"): Promise<void>;
      /** Native OS toast. Missing permission is a silent skip. */
      notify?(payload: { title: string; body: string; botId?: string }): Promise<boolean>;
      onNotifyClick?(cb: (botId: string) => void): () => void;
      /** Desktop file picker for composer attachments (local paths). */
      openFiles?(): Promise<Array<{ path: string; name: string }>>;
      /** User-session harness at login (LaunchAgent / per-user service).
       * Not the Electron GUI login item. Packaged/desktop only. */
      loginItem?: {
        get(): Promise<boolean>;
        set(enabled: boolean): Promise<boolean>;
      };
      /** Menu-bar / system-tray icon. Default on. Packaged/desktop only. */
      tray?: {
        get(): Promise<boolean>;
        set(enabled: boolean): Promise<boolean>;
        setUnread(count: number): Promise<boolean>;
      };
      /** In-app auto-update (packaged app only; honest no-op in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface UpdaterState {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  message?: string;
  tokenConfigured?: boolean;
}
