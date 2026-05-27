import * as vscode from "vscode";
import { ComposeStack, DockerCli, DockerContainer, canBuildCompose, canBuildComposeContainer, canRunComposeProject, isStableContainerState } from "./dockerCli";

export type DockerTreeItem = ComposeStackItem | ContainerItem;
export type ContainerStateFilter = "running" | "inactive";

export class DockerTreeStore {
  private stacks: readonly ComposeStack[] = [];
  private readonly busyItems = new Set<string>();
  private loaded = false;

  public constructor(private readonly docker: DockerCli) {}

  public async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.refresh();
    }
  }

  public async refresh(): Promise<void> {
    this.stacks = await this.docker.listStacks();
    this.loaded = true;
  }

  public findContainer(id: string): DockerContainer | undefined {
    for (const stack of this.stacks) {
      for (const container of stack.containers) {
        if (container.id === id) {
          return container;
        }
      }
    }
    return undefined;
  }

  public containersInComposeProject(project: string): readonly DockerContainer[] {
    const stack = this.stacks.find((candidate) => candidate.isCompose && candidate.name === project);
    return stack?.containers ?? [];
  }

  public findComposeService(project: string, service: string): DockerContainer | undefined {
    return this.containersInComposeProject(project).find((container) => container.composeService === service);
  }

  public stacksFor(filter: ContainerStateFilter): readonly ComposeStack[] {
    return this.stacks.flatMap((stack) => {
      const containers = stack.containers.filter((container) => matchesFilter(container, filter));
      if (containers.length === 0) {
        return [];
      }

      return [{
        ...stack,
        id: `${filter}:${stack.id}`,
        containers
      }];
    });
  }

  public setBusy(key: string, busy: boolean): void {
    if (busy) {
      this.busyItems.add(key);
      return;
    }

    this.busyItems.delete(key);
  }

  public isBusy(key: string): boolean {
    return this.busyItems.has(key);
  }
}

export class DockerTreeProvider implements vscode.TreeDataProvider<DockerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DockerTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(
    private readonly store: DockerTreeStore,
    private readonly filter: ContainerStateFilter
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: DockerTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
    if (!element) {
      await this.store.ensureLoaded();
      return this.store.stacksFor(this.filter).map((stack) => new ComposeStackItem(stack, this.filter, this.store.isBusy(stackBusyKey(stack))));
    }

    if (element instanceof ComposeStackItem) {
      return element.stack.containers.map((container) => new ContainerItem(container, this.filter, this.store.isBusy(containerBusyKey(container))));
    }

    return [];
  }
}

export class ComposeStackItem extends vscode.TreeItem {
  public readonly contextValue: string;

  public constructor(
    public readonly stack: ComposeStack,
    filter: ContainerStateFilter,
    isBusy: boolean
  ) {
    super(stack.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `stack:${stack.id}`;
    this.description = stack.isCompose ? `${stack.containers.length} containers` : undefined;
    this.tooltip = stackTooltip(stack);
    this.iconPath = new vscode.ThemeIcon(isBusy || stackIsTransitioning(stack) ? "loading~spin" : stack.isCompose ? "layers" : "server");
    const stackType = stackContext(stack);
    this.contextValue = `${stackType}.${filter}`;
  }
}

export class ContainerItem extends vscode.TreeItem {
  public readonly contextValue: string;

  public constructor(
    public readonly container: DockerContainer,
    filter: ContainerStateFilter,
    isBusy: boolean
  ) {
    super(container.composeService ?? container.name, vscode.TreeItemCollapsibleState.None);
    this.id = `container:${container.id}`;
    this.description = container.image;
    this.tooltip = containerTooltip(container);
    this.iconPath = new vscode.ThemeIcon(isBusy || containerIsTransitioning(container) ? "loading~spin" : containerIcon(container));
    const containerType = containerContext(container);
    this.contextValue = `${containerType}.${filter}`;
    this.command = {
      command: "dockerContainerStacks.openLogs",
      title: "Open Logs",
      arguments: [this]
    };
  }
}

function stackTooltip(stack: ComposeStack): string {
  const lines = [
    stack.isCompose ? `Compose project: ${stack.name}` : stack.name,
    stack.workingDir ? `Working directory: ${stack.workingDir}` : undefined,
    stack.configFiles.length > 0 ? `Compose files: ${stack.configFiles.join(", ")}` : undefined
  ];

  return lines.filter(Boolean).join("\n");
}

function containerTooltip(container: DockerContainer): string {
  return [
    `Name: ${container.name}`,
    `ID: ${container.id}`,
    container.composeService ? `Service: ${container.composeService}` : undefined,
    `Image: ${container.image}`
  ].filter(Boolean).join("\n");
}

function containerIcon(container: DockerContainer): string {
  if (container.state === "running") {
    return "vm-running";
  }
  return "vm";
}

function containerIsTransitioning(container: DockerContainer): boolean {
  return !isStableContainerState(container);
}

function stackIsTransitioning(stack: ComposeStack): boolean {
  return stack.containers.some(containerIsTransitioning);
}

function matchesFilter(container: DockerContainer, filter: ContainerStateFilter): boolean {
  if (filter === "running") {
    return container.state === "running";
  }

  return container.state === "exited" || container.state === "created";
}

function stackContext(stack: ComposeStack): string {
  if (canBuildCompose(stack)) {
    return "composeStackBuildable";
  }
  if (canRunComposeProject(stack)) {
    return "composeStack";
  }
  return "standaloneStack";
}

function containerContext(container: DockerContainer): string {
  if (canBuildComposeContainer(container)) {
    return "composeContainerBuildable";
  }
  if (container.composeService) {
    return "composeContainer";
  }
  return "dockerContainer";
}

export function stackBusyKey(stack: ComposeStack): string {
  return `stack:${stack.name}`;
}

export function containerBusyKey(container: DockerContainer): string {
  return `container:${container.id}`;
}
