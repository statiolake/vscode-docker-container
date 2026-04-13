import * as vscode from "vscode";
import { DockerCli } from "./dockerCli";
import { LogDocumentProvider } from "./logDocument";
import { ComposeStackItem, ContainerItem, DockerTreeProvider } from "./tree";

const logScheme = "docker-container-log";

export function activate(context: vscode.ExtensionContext): void {
  const docker = createDockerCli();
  const treeProvider = new DockerTreeProvider(docker);
  const logProvider = new LogDocumentProvider(docker);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(logScheme, logProvider),
    vscode.window.registerTreeDataProvider("dockerContainerStacks", treeProvider),
    vscode.commands.registerCommand("dockerContainerStacks.refresh", () => runWithRefresh(treeProvider, () => treeProvider.refresh())),
    vscode.commands.registerCommand("dockerContainerStacks.stack.stop", (item: ComposeStackItem) => runWithRefresh(treeProvider, () => docker.stopStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.start", (item: ComposeStackItem) => runWithRefresh(treeProvider, () => docker.startStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.container.stop", (item: ContainerItem) => runWithRefresh(treeProvider, () => docker.stopContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.start", (item: ContainerItem) => runWithRefresh(treeProvider, () => docker.startContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.restart", (item: ContainerItem) => runWithRefresh(treeProvider, () => docker.restartContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.openLogs", (item: ContainerItem) => openLogs(item, logProvider))
  );
}

export function deactivate(): void {}

function createDockerCli(): DockerCli {
  const dockerPath = vscode.workspace.getConfiguration("dockerContainerStacks").get("dockerPath", "docker");
  return new DockerCli(dockerPath);
}

async function runWithRefresh(treeProvider: DockerTreeProvider, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
    await treeProvider.refresh();
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function openLogs(item: ContainerItem, logProvider: LogDocumentProvider): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: logScheme,
    path: `/${encodeURIComponent(item.container.name)}.log`,
    query: item.container.id
  });

  logProvider.refresh(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
