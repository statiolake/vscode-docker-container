# Docker Container Stacks

VS Code UI extension for managing Docker Compose stacks and containers from the local VS Code side.

This extension is intentionally declared as a UI extension:

```json
"extensionKind": ["ui"]
```

That means it runs next to the VS Code client instead of inside a remote workspace extension host. When VS Code is attached to a Dev Container, the extension still talks to the local Docker CLI and can see the host-side containers that are invisible from the Dev Container workspace extension host.

## Features

- Show running containers and exited/created containers in separate views.
- Group containers by Docker Compose project within each view.
- Stop or start a Compose stack from the tree item context menu.
- Stop, start, or restart individual containers.
- Open container logs in a read-only editor document.

## Remote-Side Containers

The first implementation deliberately optimizes for the local UI side because Dev Container visibility is the core requirement. Managing Docker engines reachable only from the remote workspace should be modeled as a separate execution target rather than hidden inside this UI-side Docker client.
