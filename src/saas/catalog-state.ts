import type { CatalogItem } from "./catalog-transport";

export type CatalogModel =
  | { status: "loading"; requestId: number; items: [] }
  | { status: "empty"; requestId: number; items: [] }
  | { status: "populated"; requestId: number; items: CatalogItem[] }
  | { status: "error"; requestId: number; items: [] }
  | { status: "auth_lost"; requestId: number; items: [] };

export type CatalogAction =
  | { type: "load_started"; requestId: number }
  | { type: "load_succeeded"; requestId: number; items: CatalogItem[] }
  | { type: "load_failed"; requestId: number }
  | { type: "auth_lost"; requestId: number };

export const INITIAL_CATALOG_MODEL: CatalogModel = { status: "loading", requestId: 0, items: [] };

export function catalogReducer(model: CatalogModel, action: CatalogAction): CatalogModel {
  if (action.type === "load_started") {
    return { status: "loading", requestId: action.requestId, items: [] };
  }
  if (action.requestId !== model.requestId || model.status !== "loading") return model;
  if (action.type === "auth_lost") {
    return { status: "auth_lost", requestId: action.requestId, items: [] };
  }
  if (action.type === "load_failed") {
    return { status: "error", requestId: action.requestId, items: [] };
  }
  return action.items.length === 0
    ? { status: "empty", requestId: action.requestId, items: [] }
    : { status: "populated", requestId: action.requestId, items: action.items };
}
