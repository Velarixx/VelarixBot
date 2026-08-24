import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { telegramDisplayedStatus } from "@/lib/telegram";
import { cn } from "@/lib/cn";
import { ApiKeyRow } from "./ApiKeys";

function saveTelegram(body: Record<string, unknown>, onStatus: (status: ConfigStatus) => void, onError: (message: string) => void) {
  return api("/api/config", { method: "PUT", body: JSON.stringify({ telegram: body }) })
    .then((status: ConfigStatus) => onStatus(status))
    .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
}

export function TelegramSettings() {
  const { state, dispatch } = useStore();
  const telegram = state.config?.telegram;
  const shown = telegramDisplayedStatus(telegram, state.connected);
  const agents = state.bots.filter((bot) => !bot.hidden);
  const [allowEntry, setAllowEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    return saveTelegram(
      body,
      (status) => dispatch({ type: "configStatus", config: status }),
      (message) => setError(message),
    ).finally(() => setSaving(false));
  };

  const allowlist = telegram?.allowlist ?? [];
  const enabled = telegram?.enabled === true;
  const configured = telegram?.configured === true;
  const statusTone =
    shown.status === "connected"
      ? "text-success"
      : shown.status === "connection_failed" || shown.status === "offline"
        ? "text-danger"
        : "text-ink-secondary";

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Telegram</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Optional remote chat. Off by default. The bot token is stored locally and never shown again. An empty
        allowlist authorizes nobody.
      </div>

      <div className={cn("mt-3 text-[13px]", statusTone)} role="status" aria-live="polite">
        {shown.statusMessage}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <ApiKeyRow section="telegram" label="Telegram bot token" placeholder="Token from @BotFather" />

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-ink">Enable Telegram</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              Stop polling immediately when this is off. The saved token stays until you disconnect.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Enable Telegram"
            aria-checked={enabled}
            disabled={saving || !configured}
            onClick={() => void persist({ enabled: !enabled })}
            className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", enabled ? "bg-accent" : "bg-raised")}
          >
            <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", enabled ? "left-[21px]" : "left-[3px]")} />
          </button>
        </div>

        <label>
          <div className="mb-1.5 text-[13px] text-ink-secondary">Agent that receives Telegram conversations</div>
          <select
            aria-label="Telegram agent"
            value={telegram?.defaultBotId ?? ""}
            disabled={saving || agents.length === 0}
            onChange={(event) => void persist({ defaultBotId: event.target.value })}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            <option value="">Select an agent</option>
            {agents.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="mb-1.5 text-[13px] text-ink-secondary">Allowlist — Telegram user ID, chat ID, or @username</div>
          <div className="flex gap-2">
            <input
              value={allowEntry}
              onChange={(event) => setAllowEntry(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const entry = allowEntry.trim();
                if (!entry) return;
                void persist({ allowlist: [...allowlist, entry] }).then(() => setAllowEntry(""));
              }}
              placeholder="123456789 or @username"
              autoComplete="off"
              aria-label="Telegram allowlist entry"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
            <button
              type="button"
              disabled={saving || !allowEntry.trim()}
              onClick={() => {
                const entry = allowEntry.trim();
                if (!entry) return;
                void persist({ allowlist: [...allowlist, entry] }).then(() => setAllowEntry(""));
              }}
              className="w-[72px] shrink-0 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {allowlist.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {allowlist.map((entry) => (
                <li key={entry} className="flex items-center justify-between gap-2 text-[13px] text-ink">
                  <span>{entry}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void persist({ allowlist: allowlist.filter((item) => item !== entry) })}
                    className="text-[12px] text-danger hover:underline disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button
          type="button"
          disabled={saving || (!configured && !enabled)}
          onClick={() => void persist({ token: "", enabled: false, allowlist: [] })}
          className="self-start rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Disconnect Telegram
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
