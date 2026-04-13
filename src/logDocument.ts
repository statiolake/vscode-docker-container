import * as vscode from "vscode";
import { DockerCli } from "./dockerCli";

export class LogDocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  public constructor(private readonly docker: DockerCli) {}

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const containerId = uri.query;
    const tail = vscode.workspace.getConfiguration("dockerContainerStacks").get("logTail", 1000);

    return this.docker.logs(containerId, tail);
  }

  public refresh(uri: vscode.Uri): void {
    this.onDidChangeEmitter.fire(uri);
  }
}
