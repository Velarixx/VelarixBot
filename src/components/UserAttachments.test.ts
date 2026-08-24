import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserAttachments } from "./UserAttachments";

const LONG_PATH =
  "/Users/dkarijopawiro/Downloads/Hermes_NSX_Security_Explorer_Project_Instructions_FINAL_REVIEWED.md";

describe("UserAttachments", () => {
  it("renders a compact chip that truncates the path and offers copy", () => {
    const markup = renderToStaticMarkup(createElement(UserAttachments, { paths: [LONG_PATH] }));
    expect(markup).toContain("truncate");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("Hermes_NSX_Security_Explorer_Project_Instructions_FINAL_REVIEWED.md");
    expect(markup).toContain(`title="${LONG_PATH}"`);
    expect(markup).toContain("Copy path");
    expect(markup).not.toMatch(/>\s*\/Users\/dkarijopawiro/);
  });
});
