import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { reportWebviewError } from "./webviewBridge";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class WebviewErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportWebviewError("render", error, info.componentStack ?? undefined);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="empty-state" role="alert">
          <h2>DBV could not render this view</h2>
          <p>
            The error was logged to the DBV output channel. Reload the webview
            after checking the log.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
