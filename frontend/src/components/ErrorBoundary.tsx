import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken view from blanking the whole app.
 *
 * Without this, a render error unmounts everything including the navigation,
 * so the user cannot even move to a working screen -- and on a system whose
 * whole claim is honest reporting, silently showing nothing is the worst
 * possible failure mode. Fail visibly, keep the rest usable.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[optimus] view crashed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-card bg-bad/8 p-5">
        <div className="text-body-sm font-medium text-bad">
          {this.props.label ?? "This view"} hit an error
        </div>
        <p className="mt-2 text-caption leading-relaxed text-muted">
          The rest of the app still works — switch tabs and come back. If it keeps
          happening the message below is what to report.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-control bg-abyss p-3 font-mono text-footnote text-faint">
          {this.state.error.message}
        </pre>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-3 text-caption font-medium text-ink underline underline-offset-4"
        >
          Try Again
        </button>
      </div>
    );
  }
}
