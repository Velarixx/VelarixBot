// Pure gate for OS toasts. The Electron shell only shows a Notification
// when this returns true — missing OS permission is a silent skip there.
export type NotifyBot = { notifications?: boolean; name?: string };
export type NotifyEvent = { type: string; ok?: boolean; stopReason?: string | null };

export function shouldNotify(bot: NotifyBot, event: NotifyEvent): boolean {
  if (bot.notifications === false) return false;
  if (event.type === "request.opened") return true;
  if (event.type === "turn.completed") return true;
  return false;
}

/** Local title/body only — never forward tool input, tokens, or paths. */
export function notifyCopy(bot: NotifyBot, event: NotifyEvent): { title: string; body: string } | null {
  if (!shouldNotify(bot, event)) return null;
  const title = bot.name?.trim() || "VelarixBot";
  if (event.type === "request.opened") return { title, body: "Needs your input" };
  if (event.type === "turn.completed") {
    const blocked = /blocked/i.test(String(event.stopReason ?? ""));
    return { title, body: event.ok && !blocked ? "Finished" : "Didn't finish" };
  }
  return null;
}
