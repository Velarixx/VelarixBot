// The bot's computer panel endpoints, routed through the ComputerProvider
// registry — no vendor imports here. The panel's remote path targets the
// bot's own binding when it is a remote provider, else the registry's
// default remote provider (the bundled Box binding when configured). The
// bot→machine binding is recorded through the composition root (routes
// never touch persistence).
import type { ComputerProvider } from "../computer/provider.ts";
import type { ComputerRegistry } from "../computer/registry.ts";
import type { BotsService } from "../services/bots.ts";
import { json, readBody, type RouteHandler } from "./context.ts";

export function createComputersRoutes(deps: {
  bots: BotsService;
  computers: ComputerRegistry;
  recordBinding(botId: string, machineId: string): void;
}): RouteHandler {
  const { bots, computers, recordBinding } = deps;

  function panelProvider(computer: string | undefined): ComputerProvider | null {
    const binding = computers.resolveBinding(computer);
    const bound = binding && binding !== "off" ? computers.get(binding) : null;
    if (bound && bound.kind !== "local") return bound;
    return computers.defaultRemote();
  }

  return async ({ req, res, path, method }) => {
    let m = path.match(/^\/api\/bots\/([\w-]+)\/computer$/);
    if (m && method === "GET") {
      const provider = panelProvider(bots.bot(m[1])?.computer);
      if (!provider) {
        json(res, 200, { configured: false, provider: null, box: null });
        return true;
      }
      const status = await provider.status(m[1]);
      json(res, 200, {
        configured: status.configured,
        provider: provider.id,
        ...(status.reason ? { reason: status.reason } : {}),
        box: status.machine
          ? { boxId: status.machine.id, state: status.machine.state, desktopAvailable: status.machine.desktopAvailable ?? null }
          : null,
      });
      return true;
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/computer\/(provision|join|sleep|exec|screenshot)$/);
    if (m && method === "POST") {
      const botId = m[1];
      const bot = bots.bot(botId);
      if (!bot) {
        json(res, 404, { error: "no such bot" });
        return true;
      }
      const provider = panelProvider(bot.computer);
      if (!provider) {
        json(res, 409, { error: 'no cloud computer provider is configured — add one under {"computer":{"providers":{…}}} in ~/.velarixbot/config.json' });
        return true;
      }
      const unsupported = (op: string) => json(res, 409, { error: `the ${provider.kind} computer provider does not support ${op}` });
      switch (m[2]) {
        case "provision": {
          const provisioned = await provider.provision({ id: botId, name: bot.name });
          recordBinding(botId, provisioned.machineId);
          json(res, 200, {
            boxId: provisioned.machineId,
            machineName: provisioned.machineName,
            reused: provisioned.reused,
            state: provisioned.state,
            joinUrl: provisioned.joinUrl ?? null,
          });
          return true;
        }
        case "join": {
          if (!provider.capabilities.desktopUrl) {
            unsupported("join");
            return true;
          }
          const conn = await provider.connectScreen(botId);
          json(res, 200, conn.kind === "url" ? { joinUrl: conn.url, state: conn.state ?? null } : { joinUrl: null });
          return true;
        }
        case "sleep":
          if (!provider.capabilities.suspend) {
            unsupported("sleep");
            return true;
          }
          await provider.suspend(botId);
          json(res, 200, { ok: true });
          return true;
        case "exec": {
          if (!provider.capabilities.exec) {
            unsupported("exec");
            return true;
          }
          const body = await readBody(req);
          let stdout = "";
          let stderr = "";
          let exitCode: number | null = null;
          for await (const ev of provider.execute(botId, String(body.command ?? "").slice(0, 4000))) {
            if (ev.type === "stdout") stdout += ev.data;
            else if (ev.type === "stderr") stderr += ev.data;
            else exitCode = ev.exitCode;
          }
          json(res, 200, { exitCode, stdout: stdout.slice(-4000), stderr: stderr.slice(-2000) });
          return true;
        }
        case "screenshot":
          if (!provider.capabilities.screenshot) {
            unsupported("screenshot");
            return true;
          }
          json(res, 200, await provider.screenshot(botId));
          return true;
      }
    }
    return false;
  };
}
