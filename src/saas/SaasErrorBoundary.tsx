import { Component, createRef, type ReactNode, type RefObject } from "react";

const retryButtonClass =
  "mt-6 inline-flex min-h-11 items-center justify-center rounded-lg border border-line bg-raised px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

interface SaasErrorFallbackProps {
  headingRef?: RefObject<HTMLHeadingElement | null>;
  onRetry(): void;
}

export function SaasErrorFallback({ headingRef, onRetry }: SaasErrorFallbackProps) {
  return (
    <main
      className="flex min-h-full items-center justify-center bg-app px-5 py-10 text-ink"
      data-saas-error-boundary="true"
    >
      <section
        role="alert"
        aria-live="assertive"
        aria-labelledby="saas-runtime-error-title"
        aria-describedby="saas-runtime-error-description"
        className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-lg"
      >
        <h1
          id="saas-runtime-error-title"
          ref={headingRef}
          tabIndex={-1}
          className="text-[20px] font-semibold tracking-tight outline-none"
        >
          We couldn’t keep this page open safely
        </h1>
        <p id="saas-runtime-error-description" className="mt-2 text-[14px] leading-6 text-ink-secondary">
          Protected content was cleared. Try again to restart from a fresh session check.
        </p>
        <button type="button" className={retryButtonClass} onClick={onRetry}>
          Try again safely
        </button>
      </section>
    </main>
  );
}

interface SaasErrorBoundaryProps {
  children: ReactNode;
}

interface SaasErrorBoundaryState {
  failed: boolean;
  recoveryKey: number;
}

export class SaasErrorBoundary extends Component<SaasErrorBoundaryProps, SaasErrorBoundaryState> {
  state: SaasErrorBoundaryState = { failed: false, recoveryKey: 0 };

  private readonly headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(): Partial<SaasErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.headingRef.current?.focus();
  }

  private readonly retry = (): void => {
    this.setState(({ recoveryKey }) => ({ failed: false, recoveryKey: recoveryKey + 1 }));
  };

  render() {
    if (this.state.failed) {
      return <SaasErrorFallback headingRef={this.headingRef} onRetry={this.retry} />;
    }
    return <div key={this.state.recoveryKey} className="contents">{this.props.children}</div>;
  }
}
