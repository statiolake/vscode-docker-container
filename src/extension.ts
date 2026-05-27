import * as vscode from "vscode";
import { DockerCli } from "./dockerCli";
import { createExpectations } from "./expectations";
import { LogDocumentProvider } from "./logDocument";
import { Expectation, RefreshScheduler } from "./refreshScheduler";
import { ComposeStackItem, ContainerItem, DockerTreeProvider, DockerTreeStore, containerBusyKey, stackBusyKey } from "./tree";

const logScheme = "docker-container-log";

const refreshMs = 10_000;

interface ActionContext {
  readonly store: DockerTreeStore;
  readonly providers: readonly DockerTreeProvider[];
  readonly scheduler: RefreshScheduler;
}

interface ActionOptions {
  readonly busyKey?: string;
  readonly expectation?: Expectation;
}

export function activate(context: vscode.ExtensionContext): void {
  const docker = createDockerCli();
  const treeStore = new DockerTreeStore(docker);
  const runningTreeProvider = new DockerTreeProvider(treeStore, "running");
  const inactiveTreeProvider = new DockerTreeProvider(treeStore, "inactive");
  const treeProviders = [runningTreeProvider, inactiveTreeProvider];
  const logProvider = new LogDocumentProvider(docker);

  const scheduler = new RefreshScheduler(
    async () => {
      try {
        await treeStore.refresh();
      } catch {
        return;
      }
      refreshProviders(treeProviders);
    },
    refreshMs
  );

  const ctx: ActionContext = { store: treeStore, providers: treeProviders, scheduler };
  const expects = createExpectations(treeStore);

  const runningView = vscode.window.createTreeView("dockerContainerStacksRunning", { treeDataProvider: runningTreeProvider });
  const inactiveView = vscode.window.createTreeView("dockerContainerStacksInactive", { treeDataProvider: inactiveTreeProvider });

  context.subscriptions.push(
    logProvider,
    vscode.workspace.registerTextDocumentContentProvider(logScheme, logProvider),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === logScheme) {
        logProvider.close(document.uri);
      }
    }),
    runningView,
    inactiveView,
    scheduler,
    scheduler.trackView(runningView),
    scheduler.trackView(inactiveView),
    vscode.commands.registerCommand("dockerContainerStacks.refresh",
      () => runAction(ctx, async () => {})),
    vscode.commands.registerCommand("dockerContainerStacks.stack.copyName",
      (item: ComposeStackItem) => copyName(item.stack.name)),
    vscode.commands.registerCommand("dockerContainerStacks.stack.stop",
      (item: ComposeStackItem) => runAction(ctx, () => docker.stopStack(item.stack), { expectation: expects.stackStopped(item.stack) })),
    vscode.commands.registerCommand("dockerContainerStacks.stack.start",
      (item: ComposeStackItem) => runAction(ctx, () => docker.startStack(item.stack), { expectation: expects.stackRunning(item.stack) })),
    vscode.commands.registerCommand("dockerContainerStacks.stack.rebuild",
      (item: ComposeStackItem) => runAction(ctx, () => docker.rebuildStack(item.stack), { busyKey: stackBusyKey(item.stack), expectation: expects.stackRebuilt(item.stack) })),
    vscode.commands.registerCommand("dockerContainerStacks.stack.down",
      (item: ComposeStackItem) => confirmAndRun("Down", `Run docker compose down for ${item.stack.name}?`,
        () => runAction(ctx, () => docker.downStack(item.stack), { busyKey: stackBusyKey(item.stack), expectation: expects.stackAbsent(item.stack) }))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.downVolumes",
      (item: ComposeStackItem) => confirmAndRun("Down -v", `Run docker compose down -v for ${item.stack.name}? This removes named volumes declared by the project.`,
        () => runAction(ctx, () => docker.downStackWithVolumes(item.stack), { busyKey: stackBusyKey(item.stack), expectation: expects.stackAbsent(item.stack) }))),
    vscode.commands.registerCommand("dockerContainerStacks.container.copyName",
      (item: ContainerItem) => copyName(item.container.name)),
    vscode.commands.registerCommand("dockerContainerStacks.container.executeBash",
      (item: ContainerItem) => executeBash(item)),
    vscode.commands.registerCommand("dockerContainerStacks.container.stop",
      (item: ContainerItem) => runAction(ctx, () => docker.stopContainer(item.container), { expectation: expects.containerStopped(item.container) })),
    vscode.commands.registerCommand("dockerContainerStacks.container.start",
      (item: ContainerItem) => runAction(ctx, () => docker.startContainer(item.container), { expectation: expects.containerRunning(item.container) })),
    vscode.commands.registerCommand("dockerContainerStacks.container.restart",
      (item: ContainerItem) => runAction(ctx, () => docker.restartContainer(item.container), { busyKey: containerBusyKey(item.container), expectation: expects.containerRunning(item.container) })),
    vscode.commands.registerCommand("dockerContainerStacks.container.rebuild",
      (item: ContainerItem) => runAction(ctx, () => docker.rebuildContainer(item.container), { busyKey: containerBusyKey(item.container), expectation: expects.containerRebuilt(item.container) })),
    vscode.commands.registerCommand("dockerContainerStacks.container.remove",
      (item: ContainerItem) => confirmAndRun("Remove", `Remove container ${item.container.name}?`,
        () => runAction(ctx, () => docker.removeContainer(item.container), { busyKey: containerBusyKey(item.container), expectation: expects.containerAbsent(item.container) }))),
    vscode.commands.registerCommand("dockerContainerStacks.openLogs",
      (item: ContainerItem) => openLogs(item))
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

async function runAction(
  ctx: ActionContext,
  operation: () => Promise<void>,
  options: ActionOptions = {}
): Promise<void> {
  if (options.busyKey) {
    ctx.store.setBusy(options.busyKey, true);
    refreshProviders(ctx.providers);
  }

  try {
    await operation();
    await ctx.store.refresh();
    if (options.expectation) {
      ctx.scheduler.expect(options.expectation);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(errorMessage(error));
  } finally {
    if (options.busyKey) {
      ctx.store.setBusy(options.busyKey, false);
    }
    refreshProviders(ctx.providers);
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
