import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DockerContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly composeProject?: string;
  readonly composeService?: string;
  readonly composeWorkingDir?: string;
  readonly composeConfigFiles?: readonly string[];
}

export interface ComposeStack {
  readonly id: string;
  readonly name: string;
  readonly isCompose: boolean;
  readonly workingDir?: string;
  readonly configFiles: readonly string[];
  readonly containers: readonly DockerContainer[];
}

export interface DockerLogStream {
  dispose(): void;
}

export interface DockerEvent {
  readonly type?: string;
  readonly Type?: string;
  readonly action?: string;
  readonly Action?: string;
  readonly id?: string;
  readonly ID?: string;
  readonly Actor?: {
    readonly ID?: string;
    readonly Attributes?: Record<string, string>;
  };
}

export interface DockerContainerEvent {
  readonly id: string;
  readonly action: string;
}

export interface DockerEventStream {
  dispose(): void;
}

export type ResourceKind = "images" | "volumes" | "buildCache";

// inUse: no prune removes it. unused: removed by `prune --all`. dangling: removed by plain `prune`.
export type ResourceUsage = "inUse" | "unused" | "dangling";

export interface DockerResource {
  readonly id: string;
  readonly name: string;
  readonly size: number | undefined;
  readonly usage: ResourceUsage;
  readonly details: readonly string[];
}

export interface ResourceSection {
  readonly kind: ResourceKind;
  readonly size: number;
  readonly reclaimable: number;
  readonly resources: readonly DockerResource[];
}

export type PruneTarget = ResourceKind | "system";

export interface PruneOptions {
  readonly all: boolean;
  readonly volumes: boolean;
}

interface DockerDfSummary {
  readonly Type: string;
  readonly Size: string;
  readonly Reclaimable: string;
}

interface DockerDfVerbose {
  readonly Images?: readonly DockerDfImage[];
  readonly Volumes?: readonly DockerDfVolume[];
  readonly BuildCache?: readonly DockerDfBuildCache[];
}

interface DockerDfImage {
  readonly ID: string;
  readonly Repository: string;
  readonly Tag: string;
  readonly Containers: string;
  readonly Size: string;
  readonly SharedSize: string;
  readonly UniqueSize: string;
  readonly CreatedSince: string;
}

interface DockerDfVolume {
  readonly Name: string;
  readonly Driver: string;
  readonly Labels: string;
  readonly Links: string;
  readonly Size: string;
}

interface DockerDfBuildCache {
  readonly ID: string;
  readonly CacheType: string;
  readonly Description: string;
  readonly InUse: string;
  readonly Size: string;
  readonly LastUsedSince: string;
}

interface DockerInspectContainer {
  readonly Id: string;
  readonly Name?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Record<string, string>;
  };
  readonly State?: {
    readonly Status?: string;
    readonly Health?: {
      readonly Status?: string;
    };
  };
}

export class DockerCli {
  public constructor(private readonly dockerPath: string) {}

  public async listStacks(): Promise<readonly ComposeStack[]> {
    const containerIds = await this.containerIds();
    if (containerIds.length === 0) {
      return [];
    }

    const inspected = await this.inspectContainers(containerIds);
    const containers = inspected.map(toDockerContainer);
    const grouped = new Map<string, DockerContainer[]>();

    for (const container of containers) {
      const key = container.composeProject ?? "__standalone__";
      const group = grouped.get(key);
      if (group) {
        group.push(container);
      } else {
        grouped.set(key, [container]);
      }
    }

    return [...grouped.entries()]
      .map(([project, group]) => toComposeStack(project, group))
      .sort((left, right) => Number(right.isCompose) - Number(left.isCompose) || left.name.localeCompare(right.name));
  }

  public async startStack(stack: ComposeStack): Promise<void> {
    if (canRunComposeProject(stack)) {
      await this.runComposeProject(stack, ["start"]);
      return;
    }

    await this.run("start", stack.containers.map((container) => container.id));
  }

  public async stopStack(stack: ComposeStack): Promise<void> {
    if (canRunComposeProject(stack)) {
      await this.runComposeProject(stack, ["stop"]);
      return;
    }

    await this.run("stop", stack.containers.map((container) => container.id));
  }

  public async rebuildStack(stack: ComposeStack): Promise<void> {
    assertCanBuildCompose(stack);
    await this.runComposeWithFiles(stack, ["up", "--build", "--detach"]);
  }

  public async downStack(stack: ComposeStack): Promise<void> {
    assertCanRunComposeProject(stack);
    await this.runComposeProject(stack, ["down"]);
  }

  public async downStackWithVolumes(stack: ComposeStack): Promise<void> {
    assertCanRunComposeProject(stack);
    await this.runComposeProject(stack, ["down", "--volumes"]);
  }

  public async startContainer(container: DockerContainer): Promise<void> {
    await this.run("start", [container.id]);
  }

  public async stopContainer(container: DockerContainer): Promise<void> {
    await this.run("stop", [container.id]);
  }

  public async restartContainer(container: DockerContainer): Promise<void> {
    await this.run("restart", [container.id]);
  }

  public async rebuildContainer(container: DockerContainer): Promise<void> {
    const service = composeService(container);
    const stack = stackForComposeContainer(container);
    assertCanBuildCompose(stack);
    await this.runComposeWithFiles(stack, ["up", "--build", "--detach", service]);
  }

  public async removeContainer(container: DockerContainer): Promise<void> {
    await this.run("rm", [container.id]);
  }

  public async logs(containerId: string, tail: number): Promise<string> {
    const args = ["logs"];
    if (tail > 0) {
      args.push("--tail", String(tail));
    }
    args.push(containerId);

    const result = await this.exec(args);
    return result.stdout + result.stderr;
  }

  public streamLogs(containerId: string, tail: number, onData: (chunk: string) => void, onError: (error: string) => void): DockerLogStream {
    const args = ["logs", "--follow"];
    if (tail > 0) {
      args.push("--tail", String(tail));
    }
    args.push(containerId);

    const child = spawn(this.dockerPath, args);
    child.stdout.on("data", (chunk: Buffer) => onData(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => onData(chunk.toString()));
    child.on("error", (error) => onError(error.message));

    return {
      dispose: () => {
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }

  public async listResources(): Promise<readonly ResourceSection[]> {
    const [summaryResult, detailResult] = await Promise.all([
      this.exec(["system", "df", "--format", "{{json .}}"]),
      this.exec(["system", "df", "--verbose", "--format", "{{json .}}"])
    ]);
    const summaries = parseJsonLines(summaryResult.stdout) as DockerDfSummary[];
    const detail = JSON.parse(detailResult.stdout) as DockerDfVerbose;

    return [
      toResourceSection("images", summaries, (detail.Images ?? []).map(toImageResource)),
      toResourceSection("volumes", summaries, (detail.Volumes ?? []).map(toVolumeResource)),
      toResourceSection("buildCache", summaries, (detail.BuildCache ?? []).map(toBuildCacheResource))
    ];
  }

  public async prune(target: PruneTarget, options: PruneOptions): Promise<string | undefined> {
    const args = [pruneCommand(target), "prune", "--force"];
    if (options.all) {
      args.push("--all");
    }
    if (options.volumes) {
      args.push("--volumes");
    }

    const result = await this.exec(args);
    return reclaimedSpace(result.stdout);
  }

  public streamEvents(onEvent: (event: DockerEvent) => void, onError: (error: string) => void): DockerEventStream {
    const child = spawn(this.dockerPath, [
      "events",
      "--filter",
      "type=container",
      "--filter",
      "type=image",
      "--filter",
      "type=volume",
      "--format",
      "{{json .}}"
    ]);
    let disposed = false;
    let stdoutBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          onEvent(JSON.parse(line) as DockerEvent);
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      onError(chunk.toString());
    });
    child.on("error", (error) => {
      if (!disposed) {
        onError(error.message);
      }
    });
    child.on("close", (code, signal) => {
      if (!disposed && (code !== 0 || signal)) {
        onError(`docker events exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      }
    });

    return {
      dispose: () => {
        disposed = true;
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }

  private async containerIds(): Promise<readonly string[]> {
    const result = await this.exec(["container", "ls", "--all", "--quiet"]);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async inspectContainers(containerIds: readonly string[]): Promise<readonly DockerInspectContainer[]> {
    const result = await this.exec(["inspect", ...containerIds]);
    return JSON.parse(result.stdout) as DockerInspectContainer[];
  }

  private async run(subcommand: string, values: readonly string[]): Promise<void> {
    if (values.length === 0) {
      return;
    }

    await this.exec([subcommand, ...values]);
  }

  private async runComposeWithFiles(stack: ComposeStack, action: readonly string[]): Promise<void> {
    const composeArgs = ["compose"];
    for (const configFile of stack.configFiles) {
      composeArgs.push("--file", configFile);
    }
    composeArgs.push("--project-name", stack.name, ...action);

    await this.exec(composeArgs, stack.workingDir);
  }

  private async runComposeProject(stack: ComposeStack, action: readonly string[]): Promise<void> {
    await this.exec(["compose", "--project-name", stack.name, ...action]);
  }

  private async exec(args: readonly string[], cwd?: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
    try {
      return await execFileAsync(this.dockerPath, [...args], {
        cwd,
        maxBuffer: 16 * 1024 * 1024
      });
    } catch (error) {
      if (isExecError(error)) {
        const message = [error.stderr, error.stdout, error.message].filter(Boolean).join("\n").trim();
        throw new Error(message.length > 0 ? message : `docker ${args.join(" ")} failed`);
      }
      throw error;
    }
  }
}

function toDockerContainer(container: DockerInspectContainer): DockerContainer {
  const labels = container.Config?.Labels ?? {};
  const name = container.Name?.replace(/^\//, "") || container.Id.slice(0, 12);
  const configFiles = splitComposeConfigFiles(labels["com.docker.compose.project.config_files"]);

  return {
    id: container.Id,
    name,
    image: container.Config?.Image ?? "",
    state: container.State?.Status ?? "unknown",
    status: healthAwareStatus(container),
    composeProject: labels["com.docker.compose.project"],
    composeService: labels["com.docker.compose.service"],
    composeWorkingDir: labels["com.docker.compose.project.working_dir"],
    composeConfigFiles: configFiles
  };
}

function toComposeStack(project: string, containers: readonly DockerContainer[]): ComposeStack {
  if (project === "__standalone__") {
    return {
      id: project,
      name: "Standalone Containers",
      isCompose: false,
      configFiles: [],
      containers: sortContainers(containers)
    };
  }

  const firstContainer = containers[0];
  return {
    id: project,
    name: project,
    isCompose: true,
    workingDir: firstContainer?.composeWorkingDir,
    configFiles: firstContainer?.composeConfigFiles ?? [],
    containers: sortContainers(containers)
  };
}

function sortContainers(containers: readonly DockerContainer[]): readonly DockerContainer[] {
  return [...containers].sort((left, right) => {
    return (left.composeService ?? left.name).localeCompare(right.composeService ?? right.name);
  });
}

function splitComposeConfigFiles(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  return value.split(",").map((file) => file.trim()).filter((file) => file.length > 0);
}

export function canRunComposeProject(stack: ComposeStack): boolean {
  return stack.isCompose && stack.name.length > 0;
}

function assertCanRunComposeProject(stack: ComposeStack): void {
  if (!canRunComposeProject(stack)) {
    throw new Error("This stack does not include Docker Compose project metadata.");
  }
}

export function canBuildCompose(stack: ComposeStack): boolean {
  return canRunComposeProject(stack) && stack.configFiles.length > 0 && stack.configFiles.every((configFile) => existsSync(configFile));
}

function assertCanBuildCompose(stack: ComposeStack): void {
  if (!canBuildCompose(stack)) {
    throw new Error("This container does not include usable Docker Compose metadata to rebuild it.");
  }
}

function stackForComposeContainer(container: DockerContainer): ComposeStack {
  return {
    id: container.composeProject ?? "",
    name: container.composeProject ?? "",
    isCompose: Boolean(container.composeProject && container.composeService),
    workingDir: container.composeWorkingDir,
    configFiles: container.composeConfigFiles ?? [],
    containers: [container]
  };
}

function composeService(container: DockerContainer): string {
  if (!container.composeService) {
    throw new Error("This container is not part of a Docker Compose service.");
  }

  return container.composeService;
}

export function canBuildComposeContainer(container: DockerContainer): boolean {
  return canBuildCompose(stackForComposeContainer(container));
}

export function isStableContainerState(container: DockerContainer): boolean {
  if (container.status === "starting" || container.status === "stopping") {
    return false;
  }

  return container.state === "running"
    || container.state === "exited"
    || container.state === "created"
    || container.state === "paused"
    || container.state === "dead";
}

const summaryTypes: Record<ResourceKind, string> = {
  images: "Images",
  volumes: "Local Volumes",
  buildCache: "Build Cache"
};

function toResourceSection(kind: ResourceKind, summaries: readonly DockerDfSummary[], resources: readonly DockerResource[]): ResourceSection {
  const summary = summaries.find((candidate) => candidate.Type === summaryTypes[kind]);
  if (!summary) {
    throw new Error(`docker system df did not report '${summaryTypes[kind]}'.`);
  }

  return {
    kind,
    size: parseSize(summary.Size),
    // Reclaimable is reported as e.g. "1.2GB (42%)".
    reclaimable: parseSize(summary.Reclaimable.replace(/\s*\(.*\)$/, "")),
    resources: [...resources].sort((left, right) => (right.size ?? -1) - (left.size ?? -1))
  };
}

function toImageResource(image: DockerDfImage): DockerResource {
  const untagged = image.Repository === "<none>";
  const shortId = image.ID.replace(/^sha256:/, "").slice(0, 12);
  const containers = Number(image.Containers);

  return {
    id: image.ID,
    name: untagged ? shortId : `${image.Repository}:${image.Tag}`,
    size: parseSize(image.Size),
    usage: containers > 0 ? "inUse" : untagged ? "dangling" : "unused",
    details: [
      `ID: ${shortId}`,
      `Containers: ${image.Containers}`,
      `Unique size: ${image.UniqueSize}`,
      `Shared size: ${image.SharedSize}`,
      `Created: ${image.CreatedSince}`
    ]
  };
}

function toVolumeResource(volume: DockerDfVolume): DockerResource {
  const anonymous = /(^|,)com\.docker\.volume\.anonymous=/.test(volume.Labels);
  const links = Number(volume.Links);

  return {
    id: volume.Name,
    name: volume.Name,
    // Non-local drivers do not report a size.
    size: volume.Size === "N/A" ? undefined : parseSize(volume.Size),
    usage: links > 0 ? "inUse" : anonymous ? "dangling" : "unused",
    details: [
      `Driver: ${volume.Driver}`,
      `Containers: ${volume.Links}`,
      anonymous ? "Anonymous volume" : "Named volume"
    ]
  };
}

function toBuildCacheResource(cache: DockerDfBuildCache): DockerResource {
  return {
    id: cache.ID,
    name: cache.Description || cache.ID,
    size: parseSize(cache.Size),
    usage: cache.InUse === "true" ? "inUse" : "unused",
    details: [
      `ID: ${cache.ID}`,
      `Type: ${cache.CacheType}`,
      `Last used: ${cache.LastUsedSince}`
    ]
  };
}

const sizeUnits: Record<string, number> = {
  B: 1,
  kB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15
};

// Parses docker's human-readable decimal sizes such as "704MB" or "72.9kB".
function parseSize(value: string): number {
  const match = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(value.trim());
  const multiplier = match ? sizeUnits[match[2]] : undefined;
  if (!match || multiplier === undefined) {
    throw new Error(`Unexpected size format from docker: '${value}'`);
  }
  return Number(match[1]) * multiplier;
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function pruneCommand(target: PruneTarget): string {
  switch (target) {
    case "images":
      return "image";
    case "volumes":
      return "volume";
    case "buildCache":
      return "builder";
    case "system":
      return "system";
  }
}

// `builder prune` prints "Total: X" while the others print "Total reclaimed space: X".
// Some docker versions print nothing when there was nothing to remove.
function reclaimedSpace(stdout: string): string | undefined {
  return /Total(?: reclaimed space)?:\s*(\S+)/.exec(stdout)?.[1];
}

function isExecError(error: unknown): error is { readonly stdout?: string; readonly stderr?: string; readonly message: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}

function healthAwareStatus(container: DockerInspectContainer): string {
  const health = container.State?.Health?.Status;
  if (health === "starting") {
    return "starting";
  }

  return container.State?.Status ?? "unknown";
}
