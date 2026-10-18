import * as vscode from "vscode";
import { BusySet } from "./busy";
import { DockerCli, PruneOptions, PruneTarget } from "./dockerCli";
import { LogDocumentProvider } from "./logDocument";
import { RefreshScheduler } from "./refreshScheduler";
import { ResourceSectionItem, ResourceStore, ResourceTreeProvider, resourceBusyKey, systemPruneBusyKey } from "./resources";
import { ComposeStackItem, ContainerItem, DockerTreeProvider, DockerTreeStore, containerBusyKey, stackBusyKey } from "./tree";

const logScheme = "docker-container-log";

interface ActionContext {
  readonly busy: BusySet;
  readonly stores: readonly { refresh(): Promise<void> }[];
  readonly providers: readonly { refresh(): void }[];
}

interface ActionOptions {
  readonly busyKeys?: readonly string[];
}

export function activate(context: vscode.ExtensionContext): void {
  const docker = createDockerCli();
  const busy = new BusySet();
  const treeStore = new DockerTreeStore(docker, busy);
  const resourceStore = new ResourceStore(docker, busy);
  const runningTreeProvider = new DockerTreeProvider(treeStore, "running");
  const inactiveTreeProvider = new DockerTreeProvider(treeStore, "inactive");
  const resourceTreeProvider = new ResourceTreeProvider(resourceStore);
  const logProvider = new LogDocumentProvider(docker);

  const ctx: ActionContext = {
    busy,
    stores: [treeStore, resourceStore],
    providers: [runningTreeProvider, inactiveTreeProvider, resourceTreeProvider]
  };

  const scheduler = new RefreshScheduler(
    () => refreshAll(ctx).catch(reportError),
    (event) => {
      if (treeStore.applyEvent(event)) {
        refreshProviders(ctx.providers);
      }
    },
    (onEvent, onError) => docker.streamEvents(onEvent, onError)
  );

  const runningView = vscode.window.createTreeView("dockerContainerStacksRunning", { treeDataProvider: runningTreeProvider });
  const inactiveView = vscode.window.createTreeView("dockerContainerStacksInactive", { treeDataProvider: inactiveTreeProvider });
  const resourcesView = vscode.window.createTreeView("dockerContainerStacksResources", { treeDataProvider: resourceTreeProvider });

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
    resourcesView,
    scheduler,
    scheduler.trackView(runningView),
    scheduler.trackView(inactiveView),
    scheduler.trackView(resourcesView),
    vscode.commands.registerCommand("dockerContainerStacks.refresh",
      () => runAction(ctx, async () => {})),
    vscode.commands.registerCommand("dockerContainerStacks.stack.copyName",
      (item: ComposeStackItem) => copyName(item.stack.name)),
    vscode.commands.registerCommand("dockerContainerStacks.stack.stop",
      (item: ComposeStackItem) => runAction(ctx, () => docker.stopStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.start",
      (item: ComposeStackItem) => runAction(ctx, () => docker.startStack(item.stack))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.rebuild",
      (item: ComposeStackItem) => runAction(ctx, () => docker.rebuildStack(item.stack), { busyKeys: [stackBusyKey(item.stack)] })),
    vscode.commands.registerCommand("dockerContainerStacks.stack.down",
      (item: ComposeStackItem) => confirmAndRun("Down", `Run docker compose down for ${item.stack.name}?`,
        () => runAction(ctx, () => docker.downStack(item.stack), { busyKeys: [stackBusyKey(item.stack)] }))),
    vscode.commands.registerCommand("dockerContainerStacks.stack.downVolumes",
      (item: ComposeStackItem) => confirmAndRun("Down -v", `Run docker compose down -v for ${item.stack.name}? This removes named volumes declared by the project.`,
        () => runAction(ctx, () => docker.downStackWithVolumes(item.stack), { busyKeys: [stackBusyKey(item.stack)] }))),
    vscode.commands.registerCommand("dockerContainerStacks.container.copyName",
      (item: ContainerItem) => copyName(item.container.name)),
    vscode.commands.registerCommand("dockerContainerStacks.container.executeBash",
      (item: ContainerItem) => executeBash(item)),
    vscode.commands.registerCommand("dockerContainerStacks.container.stop",
      (item: ContainerItem) => runAction(ctx, () => docker.stopContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.start",
      (item: ContainerItem) => runAction(ctx, () => docker.startContainer(item.container))),
    vscode.commands.registerCommand("dockerContainerStacks.container.restart",
      (item: ContainerItem) => runAction(ctx, () => docker.restartContainer(item.container), { busyKeys: [containerBusyKey(item.container)] })),
    vscode.commands.registerCommand("dockerContainerStacks.container.rebuild",
      (item: ContainerItem) => runAction(ctx, () => docker.rebuildContainer(item.container), { busyKeys: [containerBusyKey(item.container)] })),
    vscode.commands.registerCommand("dockerContainerStacks.container.remove",
      (item: ContainerItem) => confirmAndRun("Remove", `Remove container ${item.container.name}?`,
        () => runAction(ctx, () => docker.removeContainer(item.container), { busyKeys: [containerBusyKey(item.container)] }))),
    vscode.commands.registerCommand("dockerContainerStacks.openLogs",
      (item: ContainerItem) => openLogs(item)),
    ...registerPruneCommands(ctx, docker)
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

interface PruneCommand {
  readonly command: string;
  readonly target: PruneTarget;
  readonly options: PruneOptions;
  readonly label: string;
  readonly message: string;
}

const pruneCommands: readonly PruneCommand[] = [
  {
    command: "dockerContainerStacks.system.prune",
    target: "system",
    options: { all: false, volumes: false },
    label: "Prune",
    message: "Run docker system prune? This removes stopped containers, unused networks, dangling images and dangling build cache."
  },
  {
    command: "dockerContainerStacks.system.pruneAll",
    target: "system",
    options: { all: true, volumes: false },
    label: "Prune All",
    message: "Run docker system prune -a? This removes stopped containers, unused networks, all unused images and all build cache."
  },
  {
    command: "dockerContainerStacks.system.pruneVolumes",
    target: "system",
    options: { all: false, volumes: true },
    label: "Prune",
    message: "Run docker system prune --volumes? This removes stopped containers, unused networks, dangling images, dangling build cache and unused anonymous volumes."
  },
  {
    command: "dockerContainerStacks.system.pruneAllVolumes",
    target: "system",
    options: { all: true, volumes: true },
    label: "Prune All",
    message: "Run docker system prune -a --volumes? This removes stopped containers, unused networks, all unused images, all build cache and unused anonymous volumes."
  },
  {
    command: "dockerContainerStacks.images.prune",
    target: "images",
    options: { all: false, volumes: false },
    label: "Prune",
    message: "Run docker image prune? This removes dangling images."
  },
  {
    command: "dockerContainerStacks.images.pruneAll",
    target: "images",
    options: { all: true, volumes: false },
    label: "Prune All",
    message: "Run docker image prune -a? This removes all images not used by any container."
  },
  {
    command: "dockerContainerStacks.volumes.prune",
    target: "volumes",
    options: { all: false, volumes: false },
    label: "Prune",
    message: "Run docker volume prune? This removes anonymous volumes not used by any container."
  },
  {
    command: "dockerContainerStacks.volumes.pruneAll",
    target: "volumes",
    options: { all: true, volumes: false },
    label: "Prune All",
    message: "Run docker volume prune -a? This removes ALL volumes not used by any container, including named volumes."
  },
  {
    command: "dockerContainerStacks.buildCache.prune",
    target: "buildCache",
    options: { all: false, volumes: false },
    label: "Prune",
    message: "Run docker builder prune? This removes dangling build cache."
  },
  {
    command: "dockerContainerStacks.buildCache.pruneAll",
    target: "buildCache",
    options: { all: true, volumes: false },
    label: "Prune All",
    message: "Run docker builder prune -a? This removes all unused build cache."
  }
];

function registerPruneCommands(ctx: ActionContext, docker: DockerCli): vscode.Disposable[] {
  return pruneCommands.map((prune) => vscode.commands.registerCommand(prune.command,
    (_item?: ResourceSectionItem) => confirmAndRun(prune.label, prune.message,
      () => runAction(ctx, async () => {
        const reclaimed = await docker.prune(prune.target, prune.options);
        void vscode.window.showInformationMessage(reclaimed === undefined ? "Prune completed." : `Prune completed. Reclaimed ${reclaimed}.`);
      }, { busyKeys: [prune.target === "system" ? systemPruneBusyKey : resourceBusyKey(prune.target)] }))));
}

async function runAction(
  ctx: ActionContext,
  operation: () => Promise<void>,
  options: ActionOptions = {}
): Promise<void> {
  const busyKeys = options.busyKeys ?? [];
  for (const key of busyKeys) {
    ctx.busy.set(key, true);
  }
  refreshProviders(ctx.providers);

  try {
    await operation();
    await refreshAll(ctx);
  } catch (error) {
    reportError(error);
  } finally {
    for (const key of busyKeys) {
      ctx.busy.set(key, false);
    }
    refreshProviders(ctx.providers);
  }
}

async function refreshAll(ctx: ActionContext): Promise<void> {
  await Promise.all(ctx.stores.map((store) => store.refresh()));
  refreshProviders(ctx.providers);
}

function reportError(error: unknown): void {
  void vscode.window.showErrorMessage(errorMessage(error));
}

function refreshProviders(treeProviders: readonly { refresh(): void }[]): void {
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
