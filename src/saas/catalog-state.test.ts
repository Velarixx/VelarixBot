import { describe, expect, it } from "vitest";
import { catalogReducer, INITIAL_CATALOG_MODEL, type CatalogModel } from "./catalog-state";
import type { CatalogItem } from "./catalog-transport";

const item: CatalogItem = {
  name: "Planner",
  title: "Planning assistant",
  description: "Builds a plan.",
  color: "green",
};

describe("ephemeral catalog state", () => {
  it("models loading, empty, populated, retryable failure, and auth loss", () => {
    const loading = catalogReducer(INITIAL_CATALOG_MODEL, { type: "load_started", requestId: 1 });
    expect(catalogReducer(loading, { type: "load_succeeded", requestId: 1, items: [] }).status).toBe("empty");
    expect(catalogReducer(loading, { type: "load_succeeded", requestId: 1, items: [item] })).toEqual({
      status: "populated",
      requestId: 1,
      items: [item],
    });
    expect(catalogReducer(loading, { type: "load_failed", requestId: 1 })).toEqual({
      status: "error",
      requestId: 1,
      items: [],
    });
    expect(catalogReducer(loading, { type: "auth_lost", requestId: 1 })).toEqual({
      status: "auth_lost",
      requestId: 1,
      items: [],
    });
  });

  it("clears prior data on retry and suppresses stale async completions", () => {
    const ready: CatalogModel = { status: "populated", requestId: 1, items: [item] };
    const retrying = catalogReducer(ready, { type: "load_started", requestId: 2 });
    expect(retrying).toEqual({ status: "loading", requestId: 2, items: [] });
    expect(catalogReducer(retrying, { type: "load_succeeded", requestId: 1, items: [item] })).toBe(retrying);
    expect(catalogReducer(retrying, { type: "auth_lost", requestId: 1 })).toBe(retrying);
  });

  it("does not accept a second completion for a finished request", () => {
    const loading = catalogReducer(INITIAL_CATALOG_MODEL, { type: "load_started", requestId: 7 });
    const failed = catalogReducer(loading, { type: "load_failed", requestId: 7 });
    expect(catalogReducer(failed, { type: "load_succeeded", requestId: 7, items: [item] })).toBe(failed);
  });

  it("replaces only safe ready-state projections and clears them unconditionally on session loss", () => {
    const empty: CatalogModel = { status: "empty", requestId: 4, items: [] };
    expect(catalogReducer(empty, { type: "catalog_replaced", items: [item] })).toEqual({
      status: "populated",
      requestId: 4,
      items: [item],
    });

    const loading: CatalogModel = { status: "loading", requestId: 5, items: [] };
    expect(catalogReducer(loading, { type: "catalog_replaced", items: [item] })).toBe(loading);
    expect(catalogReducer({ status: "populated", requestId: 6, items: [item] }, { type: "protected_cleared" }))
      .toEqual({ status: "auth_lost", requestId: 6, items: [] });
  });
});
