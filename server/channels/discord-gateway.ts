// Discord Gateway session: identify, heartbeat, resume, reconnect.
// Transport is injectable so tests never open a live socket.
import {
  DEFAULT_DISCORD_GATEWAY_URL,
  DISCORD_GATEWAY_INTENTS,
  DISCORD_OP,
  redactDiscordToken,
  type DiscordAllowlists,
} from "./discord-protocol.ts";

export interface DiscordGatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export interface DiscordGatewaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DiscordGatewayHandlers {
  onOpen?(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
  onError?(error: Error): void;
}

export interface DiscordGatewayTransport {
  connect(url: string, handlers: DiscordGatewayHandlers): DiscordGatewaySocket;
}

export interface DiscordReadyUser {
  id: string;
  username?: string;
  bot?: boolean;
}

export interface DiscordGatewayListener {
  onReady?(user: DiscordReadyUser, sessionId: string): void;
  onResumed?(): void;
  onDispatch?(event: string, data: unknown, seq: number | null): void;
  onClose?(code: number, reason: string): void;
  onError?(message: string): void;
}

export interface DiscordGatewaySession {
  connect(token: string): void;
  disconnect(): void;
  heartbeat(): void;
  lastSequence(): number | null;
  sessionId(): string | null;
  identified(): boolean;
  connected(): boolean;
}

export interface DiscordScheduler {
  every(ms: number, fn: () => void): () => void;
}

export function defaultDiscordScheduler(): DiscordScheduler {
  return {
    every(ms, fn) {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** In-process Gateway. Tests push payloads and read sent frames. No network. */
export function createFakeDiscordGateway(): {
  transport: DiscordGatewayTransport;
  sent: DiscordGatewayPayload[];
  connected: boolean;
  url: string | null;
  hello(heartbeatMs?: number): void;
  ready(user?: DiscordReadyUser, sessionId?: string, seq?: number): void;
  resumed(seq?: number): void;
  dispatch(event: string, data: unknown, seq?: number): void;
  invalidSession(resumable?: boolean): void;
  reconnect(): void;
  close(code?: number, reason?: string): void;
  lastIdentify(): { token?: string; intents?: number } | null;
  lastResume(): { token?: string; session_id?: string; seq?: number | null } | null;
  lastHeartbeat(): number | null;
  whenConnected(): Promise<void>;
} {
  let handlers: DiscordGatewayHandlers | null = null;
  let socketOpen = false;
  const sent: DiscordGatewayPayload[] = [];
  let url: string | null = null;
  const connectWaiters: Array<() => void> = [];

  const transport: DiscordGatewayTransport = {
    connect(nextUrl, next) {
      url = nextUrl;
      handlers = next;
      socketOpen = true;
      for (const waiter of connectWaiters.splice(0)) waiter();
      next.onOpen?.();
      return {
        send(data) {
          try {
            sent.push(JSON.parse(data) as DiscordGatewayPayload);
          } catch {
            sent.push({ op: -1, d: data });
          }
        },
        close(code, reason) {
          if (!socketOpen) return;
          socketOpen = false;
          handlers?.onClose(code ?? 1000, reason ?? "");
        },
      };
    },
  };

  function push(payload: DiscordGatewayPayload): void {
    if (!handlers || !socketOpen) return;
    handlers.onMessage(JSON.stringify(payload));
  }

  return {
    transport,
    sent,
    get connected() {
      return socketOpen;
    },
    get url() {
      return url;
    },
    hello(heartbeatMs = 45_000) {
      push({ op: DISCORD_OP.HELLO, d: { heartbeat_interval: heartbeatMs } });
    },
    ready(user = { id: "bot-1", username: "velarix", bot: true }, sessionId = "session-1", seq = 1) {
      push({ op: DISCORD_OP.DISPATCH, t: "READY", s: seq, d: { session_id: sessionId, user, resume_gateway_url: url } });
    },
    resumed(seq = 2) {
      push({ op: DISCORD_OP.DISPATCH, t: "RESUMED", s: seq, d: {} });
    },
    dispatch(event, data, seq = 1) {
      push({ op: DISCORD_OP.DISPATCH, t: event, s: seq, d: data });
    },
    invalidSession(resumable = false) {
      push({ op: DISCORD_OP.INVALID_SESSION, d: resumable });
    },
    reconnect() {
      push({ op: DISCORD_OP.RECONNECT, d: null });
    },
    close(code = 4000, reason = "test-close") {
      if (!socketOpen) return;
      socketOpen = false;
      handlers?.onClose(code, reason);
    },
    lastIdentify() {
      const frame = [...sent].reverse().find((row) => row.op === DISCORD_OP.IDENTIFY);
      if (!frame || !frame.d || typeof frame.d !== "object") return null;
      const d = frame.d as { token?: string; intents?: number };
      return { token: d.token, intents: d.intents };
    },
    lastResume() {
      const frame = [...sent].reverse().find((row) => row.op === DISCORD_OP.RESUME);
      if (!frame || !frame.d || typeof frame.d !== "object") return null;
      const d = frame.d as { token?: string; session_id?: string; seq?: number | null };
      return { token: d.token, session_id: d.session_id, seq: d.seq ?? null };
    },
    lastHeartbeat() {
      const frame = [...sent].reverse().find((row) => row.op === DISCORD_OP.HEARTBEAT);
      return frame && (typeof frame.d === "number" || frame.d === null) ? (frame.d as number | null) : null;
    },
    whenConnected() {
      if (socketOpen) return Promise.resolve();
      return new Promise<void>((resolve) => connectWaiters.push(resolve));
    },
  };
}

export function createNodeDiscordGatewayTransport(): DiscordGatewayTransport {
  return {
    connect(url, handlers) {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => handlers.onOpen?.());
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        handlers.onMessage(data);
      });
      socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
      socket.addEventListener("error", () => handlers.onError?.(new Error("Discord Gateway socket error")));
      return {
        send(data) {
          socket.send(data);
        },
        close(code, reason) {
          socket.close(code, reason);
        },
      };
    },
  };
}

export function createDiscordGatewaySession(input: {
  transport: DiscordGatewayTransport;
  listener: DiscordGatewayListener;
  scheduler?: DiscordScheduler;
  intents?: number;
  gatewayUrl?: string;
  allowlists?: DiscordAllowlists;
}): DiscordGatewaySession {
  const intents = input.intents ?? DISCORD_GATEWAY_INTENTS;
  const scheduler = input.scheduler ?? defaultDiscordScheduler();
  let socket: DiscordGatewaySocket | null = null;
  let token = "";
  let seq: number | null = null;
  let sessionId: string | null = null;
  let resumeUrl: string | null = null;
  let identified = false;
  let pendingAck = false;
  let stopHeartbeat: (() => void) | null = null;
  let wantOpen = false;
  let resumeNext = false;

  function safeError(message: string): string {
    return redactDiscordToken(message, token);
  }

  function send(payload: DiscordGatewayPayload): void {
    if (!socket) return;
    socket.send(JSON.stringify(payload));
  }

  function identify(): void {
    send({
      op: DISCORD_OP.IDENTIFY,
      d: {
        token,
        intents,
        properties: { os: process.platform, browser: "VelarixBot", device: "VelarixBot" },
      },
    });
  }

  function resume(): void {
    send({
      op: DISCORD_OP.RESUME,
      d: { token, session_id: sessionId, seq },
    });
  }

  function heartbeat(): void {
    if (!socket) return;
    if (pendingAck) {
      input.listener.onError?.(safeError("Discord Gateway missed a heartbeat ACK; reconnecting."));
      reopen();
      return;
    }
    pendingAck = true;
    send({ op: DISCORD_OP.HEARTBEAT, d: seq });
  }

  function clearHeartbeat(): void {
    stopHeartbeat?.();
    stopHeartbeat = null;
    pendingAck = false;
  }

  function handleMessage(raw: string): void {
    let payload: DiscordGatewayPayload;
    try {
      payload = JSON.parse(raw) as DiscordGatewayPayload;
    } catch {
      input.listener.onError?.(safeError("Discord Gateway sent a frame that was not JSON."));
      return;
    }
    if (typeof payload.s === "number") seq = payload.s;
    switch (payload.op) {
      case DISCORD_OP.HELLO: {
        const interval =
          payload.d && typeof payload.d === "object" && typeof (payload.d as { heartbeat_interval?: unknown }).heartbeat_interval === "number"
            ? (payload.d as { heartbeat_interval: number }).heartbeat_interval
            : 45_000;
        clearHeartbeat();
        pendingAck = false;
        stopHeartbeat = scheduler.every(interval, heartbeat);
        if (resumeNext && sessionId) resume();
        else identify();
        resumeNext = false;
        break;
      }
      case DISCORD_OP.HEARTBEAT_ACK:
        pendingAck = false;
        break;
      case DISCORD_OP.HEARTBEAT:
        send({ op: DISCORD_OP.HEARTBEAT, d: seq });
        break;
      case DISCORD_OP.RECONNECT:
        resumeNext = Boolean(sessionId);
        reopen();
        break;
      case DISCORD_OP.INVALID_SESSION:
        identified = false;
        if (payload.d === true && sessionId) {
          resumeNext = true;
          reopen();
          break;
        }
        sessionId = null;
        seq = null;
        resumeNext = false;
        reopen();
        break;
      case DISCORD_OP.DISPATCH: {
        const event = typeof payload.t === "string" ? payload.t : "";
        if (event === "READY" && payload.d && typeof payload.d === "object") {
          const data = payload.d as { session_id?: unknown; user?: unknown; resume_gateway_url?: unknown };
          sessionId = typeof data.session_id === "string" ? data.session_id : sessionId;
          resumeUrl = typeof data.resume_gateway_url === "string" ? data.resume_gateway_url : resumeUrl;
          identified = true;
          const userRaw = data.user && typeof data.user === "object" ? (data.user as Record<string, unknown>) : {};
          const user: DiscordReadyUser = {
            id: typeof userRaw.id === "string" ? userRaw.id : "",
            ...(typeof userRaw.username === "string" ? { username: userRaw.username } : {}),
            ...(userRaw.bot === true ? { bot: true } : {}),
          };
          input.listener.onReady?.(user, sessionId ?? "");
        } else if (event === "RESUMED") {
          identified = true;
          input.listener.onResumed?.();
        }
        input.listener.onDispatch?.(event, payload.d, payload.s ?? seq);
        break;
      }
      default:
        break;
    }
  }

  function attach(url: string): void {
    socket = input.transport.connect(url, {
      onMessage: handleMessage,
      onClose(code, reason) {
        clearHeartbeat();
        socket = null;
        identified = false;
        input.listener.onClose?.(code, reason);
        if (!wantOpen) return;
        resumeNext = Boolean(sessionId) && code !== 4004;
        attach(resumeUrl || input.gatewayUrl || DEFAULT_DISCORD_GATEWAY_URL);
      },
      onError(error) {
        input.listener.onError?.(safeError(error.message));
      },
    });
  }

  function reopen(): void {
    if (!wantOpen) return;
    try {
      socket?.close(4000, "reconnect");
    } catch {
      /* already closed */
    }
    socket = null;
    clearHeartbeat();
    attach(resumeUrl || input.gatewayUrl || DEFAULT_DISCORD_GATEWAY_URL);
  }

  return {
    connect(nextToken) {
      token = nextToken;
      wantOpen = true;
      identified = false;
      resumeNext = Boolean(sessionId);
      attach(resumeUrl || input.gatewayUrl || DEFAULT_DISCORD_GATEWAY_URL);
    },
    disconnect() {
      wantOpen = false;
      identified = false;
      sessionId = null;
      seq = null;
      resumeUrl = null;
      resumeNext = false;
      clearHeartbeat();
      try {
        socket?.close(1000, "disconnect");
      } catch {
        /* already closed */
      }
      socket = null;
      token = "";
    },
    heartbeat,
    lastSequence() {
      return seq;
    },
    sessionId() {
      return sessionId;
    },
    identified() {
      return identified;
    },
    connected() {
      return Boolean(socket) && identified;
    },
  };
}
