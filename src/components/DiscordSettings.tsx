import { useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { discordDisplayedStatus } from "@/lib/discord";
import { cn } from "@/lib/cn";
import { ApiKeyRow } from "./ApiKeys";

function saveDiscord(body: Record<string, unknown>, onStatus: (status: ConfigStatus) => void, onError: (message: string) => void) {
  return api("/api/config", { method: "PUT", body: JSON.stringify({ discord: body }) })
    .then((status: ConfigStatus) => onStatus(status))
    .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
}

export function DiscordSettings() {
  const { state, dispatch } = useStore();
  const discord = state.config?.discord;
  const shown = discordDisplayedStatus(discord, state.connected);
  const agents = state.bots.filter((bot) => !bot.hidden);
  const groups = state.groups;
  const [guildEntry, setGuildEntry] = useState("");
  const [channelEntry, setChannelEntry] = useState("");
  const [userEntry, setUserEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const persist = (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    return saveDiscord(
      body,
      (status) => dispatch({ type: "configStatus", config: status }),
      (message) => setError(message),
    ).finally(() => setSaving(false));
  };

  const guildAllowlist = discord?.guildAllowlist ?? [];
  const channelAllowlist = discord?.channelAllowlist ?? [];
  const userAllowlist = discord?.userAllowlist ?? [];
  const enabled = discord?.enabled === true;
  const configured = discord?.configured === true;
  const statusTone =
    shown.status === "connected" ? "text-success" : shown.status === "error" ? "text-danger" : "text-ink-secondary";

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">Discord</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Optional Gateway chat. Off by default. The bot token is stored locally and never shown again. An empty
        allowlist authorizes nobody. Conversations stay on the bound agent or group — Discord users cannot pick a
        local agent.
      </div>

      <div className={cn("mt-3 text-[13px]", statusTone)} role="status" aria-live="polite">
        {shown.statusMessage}
      </div>
      <div className="mt-1 text-[12px] text-ink-secondary" data-testid="discord-next-step">
        Next step: {shown.nextStep}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        <ApiKeyRow section="discord" label="Discord bot token" placeholder="Token from the Discord Developer Portal" />

        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[13px] text-ink">Connect Discord</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              Close the Gateway immediately when this is off. The saved token stays until you disconnect.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-label="Connect Discord"
            aria-checked={enabled}
            disabled={saving || !configured}
            onClick={() => void persist({ enabled: !enabled })}
            className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", enabled ? "bg-accent" : "bg-raised")}
          >
            <span className={cn("absolute top-[3px] size-5 rounded-full bg-white transition-all", enabled ? "left-[21px]" : "left-[3px]")} />
          </button>
        </div>

        <label>
          <div className="mb-1.5 text-[13px] text-ink-secondary">Agent bound to Discord conversations</div>
          <select
            aria-label="Discord agent"
            value={discord?.defaultBotId ?? ""}
            disabled={saving || agents.length === 0}
            onChange={(event) => void persist({ defaultBotId: event.target.value, defaultGroupId: "" })}
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

        <label>
          <div className="mb-1.5 text-[13px] text-ink-secondary">Or bind a group instead</div>
          <select
            aria-label="Discord group"
            value={discord?.defaultGroupId ?? ""}
            disabled={saving || groups.length === 0}
            onChange={(event) => void persist({ defaultGroupId: event.target.value, defaultBotId: "" })}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:border-hairline focus:outline-none"
          >
            <option value="">No group</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>

        <AllowlistField
          label="Guild allowlist"
          ariaLabel="Discord guild allowlist entry"
          placeholder="Guild snowflake"
          value={guildEntry}
          items={guildAllowlist}
          saving={saving}
          onChange={setGuildEntry}
          onAdd={(entry) => void persist({ guildAllowlist: [...guildAllowlist, entry] }).then(() => setGuildEntry(""))}
          onRemove={(entry) => void persist({ guildAllowlist: guildAllowlist.filter((item) => item !== entry) })}
        />
        <AllowlistField
          label="Channel allowlist"
          ariaLabel="Discord channel allowlist entry"
          placeholder="Channel snowflake"
          value={channelEntry}
          items={channelAllowlist}
          saving={saving}
          onChange={setChannelEntry}
          onAdd={(entry) => void persist({ channelAllowlist: [...channelAllowlist, entry] }).then(() => setChannelEntry(""))}
          onRemove={(entry) => void persist({ channelAllowlist: channelAllowlist.filter((item) => item !== entry) })}
        />
        <AllowlistField
          label="User allowlist"
          ariaLabel="Discord user allowlist entry"
          placeholder="User snowflake or @username"
          value={userEntry}
          items={userAllowlist}
          saving={saving}
          onChange={setUserEntry}
          onAdd={(entry) => void persist({ userAllowlist: [...userAllowlist, entry] }).then(() => setUserEntry(""))}
          onRemove={(entry) => void persist({ userAllowlist: userAllowlist.filter((item) => item !== entry) })}
        />

        <button
          type="button"
          disabled={saving || (!configured && !enabled)}
          onClick={() => void persist({ token: "", enabled: false })}
          className="self-start rounded-lg bg-raised px-3 py-1.5 text-[13px] text-danger hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Disconnect Discord
        </button>
      </div>
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

function AllowlistField({
  label,
  ariaLabel,
  placeholder,
  value,
  items,
  saving,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string;
  ariaLabel: string;
  placeholder: string;
  value: string;
  items: string[];
  saving: boolean;
  onChange: (value: string) => void;
  onAdd: (entry: string) => void;
  onRemove: (entry: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const entry = value.trim();
            if (!entry) return;
            onAdd(entry);
          }}
          placeholder={placeholder}
          autoComplete="off"
          aria-label={ariaLabel}
          className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
        />
        <button
          type="button"
          disabled={saving || !value.trim()}
          onClick={() => {
            const entry = value.trim();
            if (!entry) return;
            onAdd(entry);
          }}
          className="w-[72px] shrink-0 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {items.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {items.map((entry) => (
            <li key={entry} className="flex items-center justify-between gap-2 text-[13px] text-ink">
              <span>{entry}</span>
              <button
                type="button"
                disabled={saving}
                onClick={() => onRemove(entry)}
                className="text-[12px] text-danger hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
