import { Component, type ErrorInfo, type ReactNode } from "react";
import { isTauri, logUiError } from "@/lib/ipc";

interface State {
  error: Error | null;
}

/** Last-resort UI for render errors: explain, show details, offer a reload. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Cairn UI error", error, info.componentStack);
    if (isTauri()) void logUiError(`render: ${error.message} ${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex h-full items-center justify-center bg-bg p-8">
        <div className="max-w-lg">
          <h1 className="text-[15px] font-semibold">Something went wrong</h1>
          <p className="mt-1 text-fg-muted">
            Cairn hit an unexpected error while drawing this screen. Your sessions keep running in
            the background; reloading the window usually recovers.
          </p>
          <pre
            data-selectable
            className="mt-4 max-h-60 overflow-auto rounded-md bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-fg-muted"
          >
            {error.message}
            {"\n"}
            {error.stack}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 h-8 rounded-md bg-accent px-3 text-accent-fg"
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
