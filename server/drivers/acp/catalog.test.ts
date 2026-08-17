import { describe, expect, it } from "vitest";

import { catalogFromAvailableModels, catalogFromModelState } from "./catalog.ts";

describe("ACP catalog parsers", () => {
  it("reads session/new availableModels and prefers currentModelId as default", () => {
    const catalog = catalogFromAvailableModels({
      models: {
        currentModelId: "auto",
        availableModels: [
          { modelId: "auto", name: "Auto" },
          { modelId: "gemini-9-preview", name: "Gemini 9 Preview" },
        ],
      },
    });
    expect(catalog).toEqual({
      default: "auto",
      options: [
        { id: "auto", label: "Auto" },
        { id: "gemini-9-preview", label: "Gemini 9 Preview" },
      ],
    });
  });

  it("treats initialize currentModelId-only as no catalog", () => {
    expect(catalogFromModelState({ _meta: { modelState: { currentModelId: "grok-4.5" } } })).toBeNull();
    expect(catalogFromAvailableModels({ models: { currentModelId: "auto" } })).toBeNull();
  });

  it("reads initialize _meta.modelState.availableModels when a list exists", () => {
    const catalog = catalogFromModelState({
      _meta: {
        modelState: {
          currentModelId: "grok-4.5",
          availableModels: [{ modelId: "grok-4.5" }, { modelId: "grok-4" }],
        },
      },
    });
    expect(catalog?.options.map((o) => o.id)).toEqual(["grok-4.5", "grok-4"]);
    expect(catalog?.default).toBe("grok-4.5");
  });
});
