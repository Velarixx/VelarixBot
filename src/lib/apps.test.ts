import { describe, expect, it } from "vitest";
import {
  CONNECTOR_PATHS,
  connectorHealthLabel,
  connectorHealthTone,
  enabledAppSlugs,
  filterCatalogCards,
  hubUnconfiguredCopy,
  isConnectorHealth,
  toggleEnabledApp,
} from "./apps";

describe("enabledAppSlugs", () => {
  it("treats empty or missing as none — never all connected apps", () => {
    expect(enabledAppSlugs(undefined)).toEqual([]);
    expect(enabledAppSlugs({})).toEqual([]);
    expect(enabledAppSlugs({ enabledApps: [] })).toEqual([]);
    expect(enabledAppSlugs({ enabledApps: ["", "  "] })).toEqual([]);
  });

  it("dedupes and lowercases slugs", () => {
    expect(enabledAppSlugs({ enabledApps: ["Gmail", "gmail", " slack "] })).toEqual(["gmail", "slack"]);
  });
});

describe("toggleEnabledApp", () => {
  it("adds and removes without clobbering the rest of the set", () => {
    expect(toggleEnabledApp(["gmail"], "slack")).toEqual(["gmail", "slack"]);
    expect(toggleEnabledApp(["gmail", "slack"], "gmail")).toEqual(["slack"]);
  });

  it("does not invent an enable-all when the current list is empty", () => {
    expect(toggleEnabledApp([], "googledrive")).toEqual(["googledrive"]);
    expect(toggleEnabledApp([], "")).toEqual([]);
  });
});

describe("filterCatalogCards", () => {
  const cards = [
    { slug: "gmail", label: "Gmail", blurb: "Read and send email" },
    { slug: "slack", label: "Slack", blurb: "Post updates and read channels" },
  ];

  it("returns the full catalog for an empty query", () => {
    expect(filterCatalogCards(cards, "").map((c) => c.slug)).toEqual(["gmail", "slack"]);
    expect(filterCatalogCards(cards, "  ").map((c) => c.slug)).toEqual(["gmail", "slack"]);
  });

  it("matches label, slug, or blurb case-insensitively", () => {
    expect(filterCatalogCards(cards, "GMA").map((c) => c.slug)).toEqual(["gmail"]);
    expect(filterCatalogCards(cards, "channels").map((c) => c.slug)).toEqual(["slack"]);
  });
});

describe("hub empty state", () => {
  it("points at App Settings when Composio is optional and unset", () => {
    const copy = hubUnconfiguredCopy();
    expect(copy.title).toMatch(/No Composio API key/i);
    expect(copy.action).toMatch(/App Settings/);
  });
});

describe("connector health on the hub", () => {
  it("labels connected / needsAuth / error / stale and keeps unknown values inert", () => {
    expect(isConnectorHealth("connected")).toBe(true);
    expect(isConnectorHealth("needsAuth")).toBe(true);
    expect(isConnectorHealth("stale")).toBe(true);
    expect(isConnectorHealth("error")).toBe(true);
    expect(isConnectorHealth("running")).toBe(false);
    expect(connectorHealthLabel("connected")).toBe("Connected");
    expect(connectorHealthLabel("needsAuth")).toBe("Needs sign-in");
    expect(connectorHealthLabel("stale")).toBe("Sign-in expired");
    expect(connectorHealthLabel("error")).toBe("Error");
    expect(connectorHealthLabel("nope")).toBe("");
    expect(connectorHealthTone("connected")).toBe("success");
    expect(connectorHealthTone("needsAuth")).toBe("warning");
    expect(connectorHealthTone("stale")).toBe("warning");
    expect(connectorHealthTone("error")).toBe("danger");
  });
});

describe("connector paths", () => {
  it("exposes Sessions create/list/revoke plus the existing connectors and per-bot PATCH routes", () => {
    expect(CONNECTOR_PATHS.catalog).toBe("/api/connectors/catalog");
    expect(CONNECTOR_PATHS.sessions).toBe("/api/connectors/sessions");
    expect(CONNECTOR_PATHS.revoke("sess-1")).toBe("/api/connectors/sessions/sess-1");
    expect(CONNECTOR_PATHS.status(["gmail", "slack"], "bot-1")).toBe(
      "/api/connectors?services=gmail,slack&botId=bot-1",
    );
    expect(CONNECTOR_PATHS.authorize("gmail", "bot-1")).toBe("/api/connectors/gmail/authorize?botId=bot-1");
    expect(CONNECTOR_PATHS.disconnect("gmail", "bot-1")).toBe("/api/connectors/gmail?botId=bot-1");
    expect(CONNECTOR_PATHS.bot("bot-1")).toBe("/api/bots/bot-1");
  });
});
