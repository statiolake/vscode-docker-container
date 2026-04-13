import * as vscode from "vscode";
import { DockerCli } from "./dockerCli";
import { LogDocumentProvider } from "./logDocument";
import { ComposeStackItem, ContainerItem, DockerTreeProvider, DockerTreeStore, containerBusyKey, stackBusyKey } from "./tree";

const logScheme = "docker-container-log";

export function activate(context: vscode.ExtensionContext): void {
  const docker = createDockerCli();
  const treeStore = new DockerTreeStore(docker);
  const runningTreeProvider = new DockerTreeProvider(treeStore, "running");
  const inactiveTreeProvider = new DockerTreeProvider(treeStore, "inactive");
  const treeProviders = [runningTreeProvider, inactiveTreeProvider];
  const logProvider = new LogDocumentProvider(docker);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(logScheme, logProvider),
    vscode.window.registerTreeDataProvider("dockerContainerStacksRunning", runningTreeProvider),
    vscode.window.registerTreeDataProvider("dockerContainerStacksInactive", inactiveTreeProvider),
    vscode.commands.registerCommand("dockerContainerStacks.refresh", () => runWithRefresh(treeStore, treeProviders, async () => {})),
    vscode.commands.registerCommand("dockerContainerStacks.stack.stop", (item: ComposeStackItem) => runWithRefresh(treeStore, treeProviders, () => docker.stopStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.start", (item: ComposeStackItem) => runWithRefresh(treeStore, treeProviders, () => docker.startStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.rebuild", (item: ComposeStackItem) => runWithBusy(treeStore, treeProviders, stackBusyKey(item.stack), () => docker.rebuildStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.container.stop", (item: ContainerItem) => runWithRefresh(treeStore, treeProviders, () => docker.stopContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.start", (item: ContainerItem) => runWithRefresh(treeStore, treeProviders, () => docker.startContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.restart", (item: ContainerItem) => runWithBusy(treeStore, treeProviders, containerBusyKey(item.container), () => docker.restartContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.rebuild", (item: ContainerItem) => runWithBusy(treeStore, treeProviders, containerBusyKey(item.container), () => docker.rebuildContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.openLogs", (item: ContainerItem) => openLogs(item, logProvider))
  );
}

export function deactivate(): void {}

function createDockerCli(): DockerCli {
  const dockerPath = vscode.workspace.getConfiguration("dockerContainerStacks").get("dockerPath", "docker");
  return new DockerCli(dockerPath);
}

async function runWithRefresh(
  treeStore: DockerTreeStore,
  treeProviders: readonly DockerTreeProvider[],
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation();
    await treeStore.refresh();
    for (const treeProvider of treeProviders) {
      treeProvider.refresh();
    }
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  }
}

async function runWithBusy(
  treeStore: DockerTreeStore,
  treeProviders: readonly DockerTreeProvider[],
  busyKey: string,
  operation: () => Promise<void>
): Promise<void> {
  treeStore.setBusy(busyKey, true);
  refreshProviders(treeProviders);

  try {
    await operation();
    await treeStore.refresh();
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  } finally {
    treeStore.setBusy(busyKey, false);
    refreshProviders(treeProviders);
  }
}

function refreshProviders(treeProviders: readonly DockerTreeProvider[]): void {
  for (const treeProvider of treeProviders) {
    treeProvider.refresh();
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
