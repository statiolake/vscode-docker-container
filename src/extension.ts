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
    logProvider,
    vscode.workspace.registerTextDocumentContentProvider(logScheme, logProvider),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === logScheme) {
        logProvider.close(document.uri);
      }
    }),
    vscode.window.registerTreeDataProvider("dockerContainerStacksRunning", runningTreeProvider),
    vscode.window.registerTreeDataProvider("dockerContainerStacksInactive", inactiveTreeProvider),
    vscode.commands.registerCommand("dockerContainerStacks.refresh", () => runWithRefresh(treeStore, treeProviders, async () => {})),
    vscode.commands.registerCommand("dockerContainerStacks.stack.copyName", (item: ComposeStackItem) => copyName(item.stack.name)),
    vscode.commands.registerCommand("dockerContainerStacks.stack.stop", (item: ComposeStackItem) => runWithRefresh(treeStore, treeProviders, () => docker.stopStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.start", (item: ComposeStackItem) => runWithRefresh(treeStore, treeProviders, () => docker.startStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.rebuild", (item: ComposeStackItem) => runWithBusy(treeStore, treeProviders, stackBusyKey(item.stack), () => docker.rebuildStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.down", (item: ComposeStackItem) => confirmAndRun("Down", `Run docker compose down for ${item.stack.name}?`, () => runWithBusy(treeStore, treeProviders, stackBusyKey(item.stack), () => docker.downStack(item.stack)))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.downVolumes", (item: ComposeStackItem) => confirmAndRun("Down -v", `Run docker compose down -v for ${item.stack.name}? This removes named volumes declared by the project.`, () => runWithBusy(treeStore, treeProviders, stackBusyKey(item.stack), () => docker.downStackWithVolumes(item.stack)))),
    vscode.commands.registerCommand("dockerContainerStacks.container.copyName", (item: ContainerItem) => copyName(item.container.name)),
    vscode.commands.registerCommand("dockerContainerStacks.container.executeBash", (item: ContainerItem) => executeBash(item)),
    vscode.commands.registerCommand("dockerContainerStacks.container.stop", (item: ContainerItem) => runWithRefresh(treeStore, treeProviders, () => docker.stopContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.start", (item: ContainerItem) => runWithRefresh(treeStore, treeProviders, () => docker.startContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.restart", (item: ContainerItem) => runWithBusy(treeStore, treeProviders, containerBusyKey(item.container), () => docker.restartContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.rebuild", (item: ContainerItem) => runWithBusy(treeStore, treeProviders, containerBusyKey(item.container), () => docker.rebuildContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.remove", (item: ContainerItem) => confirmAndRun("Remove", `Remove container ${item.container.name}?`, () => runWithBusy(treeStore, treeProviders, containerBusyKey(item.container), () => docker.removeContainer(item.container)))),
    vscode.commands.registerCommand("dockerContainerStacks.openLogs", (item: ContainerItem) => openLogs(item))
  );
}

export function deactivate(): void {}

async function copyName(name: string): Promise<void> {
  await vscode.env.clipboard.writeText(name);
}

function executeBash(item: ContainerItem): void {
  const cwd = resolveLocalTerminalCwd();
  if (cwd === "error") {
    return;
  }

  const dockerPath = vscode.workspace.getConfiguration("dockerContainerStacks").get("dockerPath", "docker");
  const terminal = vscode.window.createTerminal({
    name: `Bash: ${item.container.name}`,
    cwd: cwd ?? undefined
  });
  terminal.show();
  terminal.sendText(`${shellQuote(dockerPath)} exec -it ${shellQuote(item.container.id)} bash`);
}

function resolveLocalTerminalCwd(): vscode.Uri | null | "error" {
  if (!vscode.env.remoteName) {
    return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
  }

  if (vscode.env.remoteName === "dev-container") {
    return vscode.Uri.file("/");
  }

  void vscode.window.showErrorMessage(`Local Docker terminal is not supported for remote type '${vscode.env.remoteName}'.`);
  return "error";
}

async function confirmAndRun(label: string, message: string, operation: () => Promise<void>): Promise<void> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, label);
  if (choice !== label) {
    return;
  }

  await operation();
}

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

async function openLogs(item: ContainerItem): Promise<void> {
  const uri = vscode.Uri.from({
    scheme: logScheme,
    path: `/${encodeURIComponent(item.container.name)}.log`,
    query: item.container.id
  });

  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: true });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
