// Channel-connector domain service. Registers connectors, fans their
// events onto the existing EventBus (and therefore the SQLite event
// log + SSE), and never consults the approval broker.
//
// Inbound channel events stream on `channel:<connectorId>` — not a bot
// thread — so standing Allow-once / Always-allow / credential rules
// cannot attach. This service must not call persistAllowRule,
// autoResolvePermission, or respondToRequest.
import {
  CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS,
  channelStreamId,
  resolveApprovalsForChannelEvent,
  type ChannelConnector,
  type ChannelConnectorEvent,
  type ChannelConnectorStatus,
  type ChannelInboundMessage,
} from "../channels/contracts.ts";
import type { ChannelRegistry } from "../channels/registry.ts";
import { newEventId, type RuntimeEvent } from "../contracts.ts";
import type { EventBus } from "../harness/bus.ts";
import type { LineageService } from "./lineage.ts";

export interface ChannelsService {
  register(connector: ChannelConnector): void;
  get(id: string): ChannelConnector | null;
  list(): ChannelConnectorStatus[];
  status(id: string): ChannelConnectorStatus | null;
  /** Always null — channel events do not inherit standing approvals. */
  approvalForInbound(message: ChannelInboundMessage): null;
}

export function channelEventToRuntime(
  connector: ChannelConnector,
  event: ChannelConnectorEvent,
  now: () => number,
  requestId?: string,
): RuntimeEvent {
  const base = {
    eventId: newEventId(),
    provider: connector.kind,
    providerInstanceId: connector.id,
    threadId: channelStreamId(connector.id),
    createdAt: new Date(now()).toISOString(),
    ...(requestId ? { requestId, lineageId: requestId } : {}),
  };
  switch (event.type) {
    case "inbound":
      return { ...base, type: "channel.inbound", connectorId: connector.id, message: event.message };
    case "outbound":
      return {
        ...base,
        type: "channel.outbound",
        connectorId: connector.id,
        outboundId: event.outboundId,
        message: event.message,
      };
    case "reaction":
      return { ...base, type: "channel.reaction", connectorId: connector.id, reaction: event.reaction };
    case "receipt":
      return { ...base, type: "channel.receipt", connectorId: connector.id, receipt: event.receipt };
    case "rate-limit":
      return { ...base, type: "channel.rate-limit", connectorId: connector.id, rateLimit: event.state };
  }
}

export function createChannelsService(deps: {
  registry: ChannelRegistry;
  bus: EventBus;
  now?: () => number;
  lineage?: LineageService;
}): ChannelsService {
  const now = deps.now ?? (() => Date.now());
  const attached = new Map<string, () => void>();

  if (CHANNEL_EVENTS_INHERIT_STANDING_APPROVALS) {
    throw new Error("channel events must not inherit standing approvals");
  }

  function publish(connector: ChannelConnector, event: ChannelConnectorEvent): void {
    if (event.type === "inbound") {
      // Pin: ingest never consults the approval broker.
      resolveApprovalsForChannelEvent(event.message);
    }
    let requestId: string | undefined;
    if (event.type === "inbound") {
      requestId = deps.lineage?.begin({ source: "channel", sourceRef: event.message.id }).requestId;
    } else if (event.type === "outbound") {
      requestId = event.message.requestId;
      if (requestId) deps.lineage?.noteOutbound(requestId, event.outboundId);
    }
    deps.bus.publish(channelEventToRuntime(connector, event, now, requestId));
  }

  function attach(connector: ChannelConnector): void {
    attached.get(connector.id)?.();
    attached.set(
      connector.id,
      connector.onEvent((event) => {
        publish(connector, event);
      }),
    );
  }

  for (const connector of deps.registry.list()) attach(connector);

  return {
    register(connector) {
      deps.registry.register(connector);
      attach(connector);
    },
    get(id) {
      return deps.registry.get(id);
    },
    list() {
      return deps.registry.statuses();
    },
    status(id) {
      return deps.registry.get(id)?.status() ?? null;
    },
    approvalForInbound(message) {
      return resolveApprovalsForChannelEvent(message);
    },
  };
}
