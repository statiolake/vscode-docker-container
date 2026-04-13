import { execFile, spawn } from "node:child_process";
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

interface DockerInspectContainer {
  readonly Id: string;
  readonly Name?: string;
  readonly Config?: {
    readonly Image?: string;
    readonly Labels?: Record<string, string>;
  };
  readonly State?: {
    readonly Status?: string;
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
    if (canRunCompose(stack)) {
      await this.runCompose(stack, ["start"]);
      return;
    }

    await this.run("start", stack.containers.map((container) => container.id));
  }

  public async stopStack(stack: ComposeStack): Promise<void> {
    if (canRunCompose(stack)) {
      await this.runCompose(stack, ["stop"]);
      return;
    }

    await this.run("stop", stack.containers.map((container) => container.id));
  }

  public async rebuildStack(stack: ComposeStack): Promise<void> {
    assertCanRunCompose(stack);
    await this.runCompose(stack, ["up", "--build", "--detach"]);
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
    assertCanRunCompose(stack);
    await this.runCompose(stack, ["up", "--build", "--detach", service]);
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

  private async runCompose(stack: ComposeStack, action: readonly string[]): Promise<void> {
    const composeArgs = ["compose"];
    for (const configFile of stack.configFiles) {
      composeArgs.push("--file", configFile);
    }
    composeArgs.push("--project-name", stack.name, ...action);

    await this.exec(composeArgs, stack.workingDir);
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
    status: container.State?.Status ?? "unknown",
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

function canRunCompose(stack: ComposeStack): boolean {
  return stack.isCompose && stack.configFiles.length > 0;
}

function assertCanRunCompose(stack: ComposeStack): void {
  if (!canRunCompose(stack)) {
    throw new Error("This container does not include enough Docker Compose metadata to rebuild it.");
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

function isExecError(error: unknown): error is { readonly stdout?: string; readonly stderr?: string; readonly message: string } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
