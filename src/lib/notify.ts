// Pure gate for OS toasts. The Electron shell only shows a Notification
// when this returns true — missing OS permission is a silent skip there.
export type NotifyEventType = "request.opened" | "turn.completed" | "stall.nudge" | "peer.reply";

export const NOTIFY_EVENTS: readonly NotifyEventType[] = [
  "request.opened",
  "turn.completed",
  "stall.nudge",
  "peer.reply",
];

export const NOTIFY_EVENT_LABELS: Record<NotifyEventType, { title: string; hint: string }> = {
  "request.opened": { title: "Needs input", hint: "Permission, question, or sign-in cards" },
  "turn.completed": { title: "Turn finished", hint: "When this bot completes a turn" },
  "stall.nudge": { title: "Still waiting", hint: "When a turn has been sitting on you" },
  "peer.reply": { title: "Peer replies", hint: "When another bot replies in a group thread" },
};

export type NotifyBot = {
  notifications?: boolean;
  name?: string;
  notifyEvents?: Partial<Record<NotifyEventType, boolean>>;
};
export type NotifyEvent = { type: string; ok?: boolean; stopReason?: string | null };

export function notifyEventEnabled(bot: NotifyBot, type: string): boolean {
  if (bot.notifications === false) return false;
  if (!NOTIFY_EVENTS.includes(type as NotifyEventType)) return false;
  const override = bot.notifyEvents?.[type as NotifyEventType];
  return override !== false;
}

export function shouldNotify(bot: NotifyBot, event: NotifyEvent): boolean {
  return notifyEventEnabled(bot, event.type);
}

/** Local title/body only — never forward tool input, tokens, or paths. */
export function notifyCopy(bot: NotifyBot, event: NotifyEvent): { title: string; body: string } | null {
  if (!shouldNotify(bot, event)) return null;
  const title = bot.name?.trim() || "VelarixBot";
  if (event.type === "request.opened") return { title, body: "Needs your input" };
  if (event.type === "stall.nudge") return { title, body: "Still waiting on you" };
  if (event.type === "peer.reply") return { title, body: "A teammate replied" };
  if (event.type === "turn.completed") {
    const blocked = /blocked/i.test(String(event.stopReason ?? ""));
    return { title, body: event.ok && !blocked ? "Finished" : "Didn't finish" };
  }
  return null;
}

export function unreadBotCount(bots: Array<{ unread?: boolean; hidden?: boolean }>): number {
  return bots.filter((b) => b.unread && !b.hidden).length;
}
