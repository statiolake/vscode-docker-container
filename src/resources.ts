import * as vscode from "vscode";
import { BusySet } from "./busy";
import { DockerCli, DockerResource, ResourceKind, ResourceSection, ResourceUsage } from "./dockerCli";

export type ResourceTreeItem = ResourceSectionItem | ResourceItem;

export class ResourceStore {
  private sections: readonly ResourceSection[] = [];
  private loaded = false;

  public constructor(private readonly docker: DockerCli, private readonly busy: BusySet) {}

  public async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.refresh();
    }
  }

  public async refresh(): Promise<void> {
    this.sections = await this.docker.listResources();
    this.loaded = true;
  }

  public allSections(): readonly ResourceSection[] {
    return this.sections;
  }

  public isBusy(section: ResourceSection): boolean {
    return this.busy.has(resourceBusyKey(section.kind)) || this.busy.has(systemPruneBusyKey);
  }
}

export class ResourceTreeProvider implements vscode.TreeDataProvider<ResourceTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ResourceTreeItem | undefined>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  public constructor(private readonly store: ResourceStore) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: ResourceTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ResourceTreeItem): Promise<ResourceTreeItem[]> {
    if (!element) {
      await this.store.ensureLoaded();
      return this.store.allSections().map((section) => new ResourceSectionItem(section, this.store.isBusy(section)));
    }

    if (element instanceof ResourceSectionItem) {
      return element.section.resources.map((resource) => new ResourceItem(element.section.kind, resource));
    }

    return [];
  }
}

const sectionLabels: Record<ResourceKind, string> = {
  images: "Images",
  volumes: "Volumes",
  buildCache: "Build Cache"
};

const sectionIcons: Record<ResourceKind, string> = {
  images: "package",
  volumes: "database",
  buildCache: "archive"
};

export class ResourceSectionItem extends vscode.TreeItem {
  public readonly contextValue: string;

  public constructor(public readonly section: ResourceSection, isBusy: boolean) {
    super(sectionLabels[section.kind], vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `resources:${section.kind}`;
    this.description = `${formatSize(section.size)} (${formatSize(section.reclaimable)} reclaimable)`;
    this.tooltip = `${section.resources.length} items\nTotal: ${formatSize(section.size)}\nReclaimable: ${formatSize(section.reclaimable)}`;
    this.iconPath = new vscode.ThemeIcon(isBusy ? "loading~spin" : sectionIcons[section.kind]);
    this.contextValue = `resourceSection.${section.kind}`;
  }
}

const usageDescriptions: Record<ResourceUsage, string> = {
  inUse: "In use",
  unused: "Unused (removed by prune --all)",
  dangling: "Dangling (removed by prune)"
};

export class ResourceItem extends vscode.TreeItem {
  public constructor(kind: ResourceKind, public readonly resource: DockerResource) {
    super(resource.name, vscode.TreeItemCollapsibleState.None);
    this.id = `resource:${kind}:${resource.id}`;
    this.description = resource.size === undefined ? "size unknown" : formatSize(resource.size);
    this.tooltip = [resource.name, usageDescriptions[resource.usage], ...resource.details].join("\n");
    this.iconPath = resourceIcon(kind, resource.usage);
  }
}

// In-use resources keep the regular icon; anything a prune would remove is dimmed.
function resourceIcon(kind: ResourceKind, usage: ResourceUsage): vscode.ThemeIcon {
  switch (usage) {
    case "inUse":
      return new vscode.ThemeIcon(sectionIcons[kind]);
    case "unused":
      return new vscode.ThemeIcon(sectionIcons[kind], new vscode.ThemeColor("disabledForeground"));
    case "dangling":
      return new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
  }
}

export function formatSize(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export const systemPruneBusyKey = "resources:system";

export function resourceBusyKey(kind: ResourceKind): string {
  return `resources:${kind}`;
}
