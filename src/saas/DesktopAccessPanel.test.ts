import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesktopAccessPanelView, type DesktopAccessModel } from "./DesktopAccessPanel";

function markup(model: DesktopAccessModel): string {
  return renderToStaticMarkup(createElement(DesktopAccessPanelView, {
    model,
    onRequest() {},
    onRetry() {},
    onRevoke() {},
  }));
}

describe("desktop access panel semantics", () => {
  it("covers loading, grant, denial, expiry, failure, revocation, and recovery actions", () => {
    expect(markup({ status: "checking" })).toMatch(/role="status"[\s\S]*aria-busy="true"[\s\S]*Checking remote desktop access/);
    expect(markup({ status: "requesting" })).toMatch(/role="status"[\s\S]*Requesting scoped access/);
    expect(markup({ status: "active", expiresAt: 2_000 })).toMatch(/Remote desktop access is active[\s\S]*Revoke access/);
    expect(markup({ status: "denied" })).toMatch(/role="alert"[\s\S]*isn.t available[\s\S]*Request access/);
    expect(markup({ status: "expired" })).toMatch(/role="alert"[\s\S]*expired[\s\S]*Request access/);
    expect(markup({ status: "unavailable", retry: "request" })).toMatch(/role="alert"[\s\S]*No access details are shown[\s\S]*Try again/);
    expect(markup({ status: "revoking" })).toMatch(/role="status"[\s\S]*Revoking remote desktop access/);
    expect(markup({ status: "revoked" })).toMatch(/role="status"[\s\S]*was revoked[\s\S]*Request access/);
  });

  it("never renders raw capability, workspace, provider, machine, or management detail", () => {
    const all = [
      markup({ status: "idle" }),
      markup({ status: "active", expiresAt: 9_999 }),
      markup({ status: "unavailable", retry: "check" }),
    ].join("\n");
    expect(all).not.toMatch(/accessToken|joinUrl|providerKind|machineId|VNC|SSH|management endpoint|9_999/i);
  });
});
