import { Component, type ReactNode } from "react";

/** Keep the portal's navigation and sign-out reachable after a section crash. */
export class ProviderContentBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return (
      <div role="alert" className="rounded-md border border-border p-6 space-y-3">
        <p>This section could not be opened. Try again, choose another section, or sign out.</p>
        <button type="button" className="underline" onClick={() => this.setState({ failed: false })}>Try opening section again</button>
      </div>
    );
    return this.props.children;
  }
}
