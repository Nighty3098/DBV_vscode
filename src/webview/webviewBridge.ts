import type { WebviewMessage } from "../shared/types";

declare function acquireVsCodeApi<T>(): {
  postMessage(message: unknown): void;
  getState(): T | undefined;
  setState(state: T): void;
};

const vscode = acquireVsCodeApi<{ mode?: string }>();

export function post(message: WebviewMessage): void {
  vscode.postMessage(message);
}

export function reportWebviewError(
  source: "render" | "runtime" | "unhandledRejection",
  error: unknown,
  componentStack?: string,
): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  post({
    type: "webviewError",
    source,
    message: normalized.message,
    stack: normalized.stack,
    componentStack,
  });
}
