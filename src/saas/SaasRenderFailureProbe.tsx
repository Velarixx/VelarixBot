import { useEffect, useRef, useState, type ReactNode } from "react";

export const SAAS_RECOVERABLE_RENDER_FAILURE_EVENT = "velarix:e2e-recoverable-render-failure";

let failureGeneration = 0;

/**
 * A production-build browser probe used only when the E2E build explicitly
 * enables it. A fresh mount adopts the latest generation, which makes the
 * boundary's retry recover deterministically without weakening production.
 */
export function SaasRenderFailureProbe({ children }: { children: ReactNode }) {
  const mountedGeneration = useRef(failureGeneration);
  const [observedGeneration, setObservedGeneration] = useState(failureGeneration);

  useEffect(() => {
    const failNextRender = () => {
      failureGeneration += 1;
      setObservedGeneration(failureGeneration);
    };
    window.addEventListener(SAAS_RECOVERABLE_RENDER_FAILURE_EVENT, failNextRender);
    return () => window.removeEventListener(SAAS_RECOVERABLE_RENDER_FAILURE_EVENT, failNextRender);
  }, []);

  if (observedGeneration > mountedGeneration.current) {
    throw new Error("Injected recoverable SaaS render failure");
  }
  return children;
}
