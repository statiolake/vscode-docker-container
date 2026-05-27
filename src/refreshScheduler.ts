import * as vscode from "vscode";
import { DockerEvent, DockerEventStream } from "./dockerCli";

export class RefreshScheduler implements vscode.Disposable {
  private stream: DockerEventStream | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private visibleCount = 0;
  private refreshing = false;
  private queuedRefresh = false;

  public constructor(
    private readonly performRefresh: () => Promise<void>,
    private readonly handleEvent: (event: DockerEvent) => void,
    private readonly streamEvents: (onEvent: (event: DockerEvent) => void, onError: (error: string) => void) => DockerEventStream
  ) {}

  public trackView(view: vscode.TreeView<unknown>): vscode.Disposable {
    let visible = view.visible;
    if (visible) {
      this.visibleCount++;
      this.updateSubscription();
      void this.refreshNow();
    }

    return view.onDidChangeVisibility((event) => {
      if (event.visible === visible) {
        return;
      }
      visible = event.visible;
      this.visibleCount += visible ? 1 : -1;
      this.updateSubscription();
      if (visible) {
        void this.refreshNow();
      }
    });
  }

  public dispose(): void {
    this.stopStream();
    this.clearRestartTimer();
  }

  private async refreshNow(): Promise<void> {
    if (this.refreshing) {
      this.queuedRefresh = true;
      return;
    }
    this.refreshing = true;
    try {
      await this.performRefresh();
    } finally {
      this.refreshing = false;
    }
    if (this.queuedRefresh) {
      this.queuedRefresh = false;
      void this.refreshNow();
    }
  }

  private updateSubscription(): void {
    if (this.visibleCount > 0) {
      if (!this.stream) {
        this.stream = this.streamEvents(
          (event) => {
            this.handleEvent(event);
            void this.refreshNow();
          },
          () => this.scheduleRestart()
        );
      }
      return;
    }

    this.stopStream();
    this.clearRestartTimer();
  }

  private scheduleRestart(): void {
    if (this.visibleCount <= 0 || this.restartTimer) {
      return;
    }
    this.stopStream();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.updateSubscription();
    }, 1_000);
  }

  private stopStream(): void {
    if (this.stream) {
      this.stream.dispose();
      this.stream = undefined;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
  }
}
