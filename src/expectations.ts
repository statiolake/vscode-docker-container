import { ComposeStack, DockerContainer } from "./dockerCli";
import { Expectation } from "./refreshScheduler";
import { DockerTreeStore } from "./tree";

const defaultTimeoutMs = 60_000;
const buildTimeoutMs = 5 * 60_000;

export interface ExpectationFactory {
  containerStopped(container: DockerContainer): Expectation;
  containerRunning(container: DockerContainer): Expectation;
  containerAbsent(container: DockerContainer): Expectation;
  containerRebuilt(container: DockerContainer): Expectation;
  stackStopped(stack: ComposeStack): Expectation;
  stackRunning(stack: ComposeStack): Expectation;
  stackAbsent(stack: ComposeStack): Expectation;
  stackRebuilt(stack: ComposeStack): Expectation;
}

export function createExpectations(store: DockerTreeStore): ExpectationFactory {
  const liveContainers = (stack: ComposeStack): readonly DockerContainer[] => {
    if (stack.isCompose) {
      return store.containersInComposeProject(stack.name);
    }
    return stack.containers
      .map((container) => store.findContainer(container.id))
      .filter((container): container is DockerContainer => container !== undefined);
  };

  const allRunning = (containers: readonly DockerContainer[]): boolean =>
    containers.length > 0 && containers.every((container) => container.state === "running");

  const allStopped = (containers: readonly DockerContainer[]): boolean =>
    containers.length > 0 && containers.every((container) => container.state !== "running");

  return {
    containerStopped: (container) => ({
      predicate: () => {
        const found = store.findContainer(container.id);
        return found === undefined || found.state !== "running";
      },
      timeoutMs: defaultTimeoutMs
    }),
    containerRunning: (container) => ({
      predicate: () => store.findContainer(container.id)?.state === "running",
      timeoutMs: defaultTimeoutMs
    }),
    containerAbsent: (container) => ({
      predicate: () => store.findContainer(container.id) === undefined,
      timeoutMs: defaultTimeoutMs
    }),
    containerRebuilt: (container) => ({
      predicate: () => {
        const project = container.composeProject;
        const service = container.composeService;
        if (!project || !service) {
          return store.findContainer(container.id)?.state === "running";
        }
        return store.findComposeService(project, service)?.state === "running";
      },
      timeoutMs: buildTimeoutMs
    }),
    stackStopped: (stack) => ({
      predicate: () => allStopped(liveContainers(stack)),
      timeoutMs: defaultTimeoutMs
    }),
    stackRunning: (stack) => ({
      predicate: () => allRunning(liveContainers(stack)),
      timeoutMs: defaultTimeoutMs
    }),
    stackAbsent: (stack) => ({
      predicate: () => liveContainers(stack).length === 0,
      timeoutMs: defaultTimeoutMs
    }),
    stackRebuilt: (stack) => ({
      predicate: () => allRunning(liveContainers(stack)),
      timeoutMs: buildTimeoutMs
    })
  };
}
