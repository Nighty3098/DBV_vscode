import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

class Logger {
  private readonly filePath = join(tmpdir(), 'dbv_code.log');
  private output: vscode.OutputChannel | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  initialize(): vscode.Disposable {
    this.output ??= vscode.window.createOutputChannel('DBV');
    this.info(`Logging to ${this.filePath}`);
    return {
      dispose: () => {
        this.output?.dispose();
        this.output = undefined;
      },
    };
  }

  info(message: string): void {
    this.write('INFO', message);
  }

  warn(message: string, error?: unknown): void {
    this.write('WARN', message, error);
  }

  error(message: string, error: unknown): void {
    this.write('ERROR', message, error);
  }

  private write(level: 'INFO' | 'WARN' | 'ERROR', message: string, error?: unknown): void {
    const details = error === undefined
      ? ''
      : error instanceof Error
        ? `\n${error.stack ?? `${error.name}: ${error.message}`}`
        : `\n${String(error)}`;
    const entry = `[${new Date().toISOString()}] [${level}] ${message}${details}`;
    this.output?.appendLine(entry);
    this.writeQueue = this.writeQueue
      .then(() => appendFile(this.filePath, `${entry}\n`, { encoding: 'utf8', mode: 0o600 }))
      .catch((writeError: unknown) => {
        this.output?.appendLine(
          `[${new Date().toISOString()}] [ERROR] Could not write log file ${this.filePath}: ${String(writeError)}`,
        );
      });
  }
}

export const logger = new Logger();
