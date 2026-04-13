import * as vscode from "vscode";
import { ComposeStack, DockerCli, DockerContainer } from "./dockerCli";

export type DockerTreeItem = ComposeStackItem | ContainerItem;

export class DockerTreeProvider implements vscode.TreeDataProvider<DockerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DockerTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private stacks: readonly ComposeStack[] = [];

  public constructor(private readonly docker: DockerCli) {}

  public async refresh(): Promise<void> {
    this.stacks = await this.docker.listStacks();
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: DockerTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
    if (!element) {
      if (this.stacks.length === 0) {
        await this.refresh();
      }
      return this.stacks.map((stack) => new ComposeStackItem(stack));
    }

    if (element instanceof ComposeStackItem) {
      return element.stack.containers.map((container) => new ContainerItem(container));
    }

    return [];
  }
}

export class ComposeStackItem extends vscode.TreeItem {
  public readonly contextValue = "composeStack";

  public constructor(public readonly stack: ComposeStack) {
    super(stack.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `stack:${stack.id}`;
    this.description = stack.isCompose ? `${stack.containers.length} containers` : undefined;
    this.tooltip = stackTooltip(stack);
    this.iconPath = new vscode.ThemeIcon(stack.isCompose ? "layers" : "server");
  }
}

export class ContainerItem extends vscode.TreeItem {
  public readonly contextValue = "dockerContainer";

  public constructor(public readonly container: DockerContainer) {
    super(container.composeService ?? container.name, vscode.TreeItemCollapsibleState.None);
    this.id = `container:${container.id}`;
    this.description = `${container.state} ${container.image}`.trim();
    this.tooltip = containerTooltip(container);
    this.iconPath = new vscode.ThemeIcon(containerIcon(container));
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
    `Image: ${container.image}`,
    `State: ${container.state}`
  ].filter(Boolean).join("\n");
}

function containerIcon(container: DockerContainer): string {
  if (container.state === "running") {
    return "vm-running";
  }
  if (container.state === "exited") {
    return "debug-stop";
  }
  return "vm";
}
