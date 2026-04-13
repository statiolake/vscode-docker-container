import * as vscode from "vscode";
import { DockerCli, DockerLogStream } from "./dockerCli";

interface LogSession {
  readonly stream: DockerLogStream;
  content: string;
}

export class LogDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly sessions = new Map<string, LogSession>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly docker: DockerCli) {}

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const key = uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      session = this.createSession(uri);
      this.sessions.set(key, session);
    }

    return session.content;
  }

  public close(uri: vscode.Uri): void {
    const key = uri.toString();
    const session = this.sessions.get(key);
    if (!session) {
      return;
    }

    session.stream.dispose();
    this.sessions.delete(key);
  }

  public dispose(): void {
    for (const session of this.sessions.values()) {
      session.stream.dispose();
    }
    this.sessions.clear();
    this.onDidChangeEmitter.dispose();
  }

  private createSession(uri: vscode.Uri): LogSession {
    const tail = vscode.workspace.getConfiguration("dockerContainerStacks").get("logTail", 1000);
    const session: LogSession = {
      content: "",
      stream: this.docker.streamLogs(
        uri.query,
        tail,
        (chunk) => {
          session.content += chunk;
          this.onDidChangeEmitter.fire(uri);
        },
        (error) => {
          session.content += `${error}\n`;
          this.onDidChangeEmitter.fire(uri);
        }
      )
    };

    return session;
  }
}
