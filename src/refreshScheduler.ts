import * as vscode from "vscode";

export interface Expectation {
  readonly predicate: () => boolean;
  readonly timeoutMs: number;
}

type Mode = "running" | "none";

interface PendingExpectation {
  readonly predicate: () => boolean;
  readonly expiresAt: number;
}

export class RefreshScheduler implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private mode: Mode = "none";
  private pending: PendingExpectation[] = [];
  private visibleCount = 0;
  private refreshing = false;

  public constructor(
    private readonly performRefresh: () => Promise<void>,
    private readonly refreshMs: number
  ) {}

  public trackView(view: vscode.TreeView<unknown>): vscode.Disposable {
    let visible = view.visible;
    if (visible) {
      this.visibleCount++;
      this.reschedule();
      void this.tick();
    }

    return view.onDidChangeVisibility((event) => {
      if (event.visible === visible) {
        return;
      }
      visible = event.visible;
      this.visibleCount += visible ? 1 : -1;
      this.reschedule();
      if (visible) {
        void this.tick();
      }
    });
  }

  public expect(expectation: Expectation): void {
    this.pending.push({
      predicate: expectation.predicate,
      expiresAt: Date.now() + expectation.timeoutMs
    });
    this.reschedule();
  }

  public dispose(): void {
    this.stopTimer();
  }

  private reschedule(): void {
    if (this.visibleCount <= 0) {
      this.setMode("none");
      return;
    }
    this.setMode("running");
  }

  private hasPending(): boolean {
    const now = Date.now();
    this.pending = this.pending.filter((entry) => {
      if (entry.expiresAt <= now) {
        return false;
      }
      try {
        return !entry.predicate();
      } catch {
        return false;
      }
    });
    return this.pending.length > 0;
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.stopTimer();
    if (mode === "none") {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.refreshMs);
  }

  private async tick(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      await this.performRefresh();
    } finally {
      this.refreshing = false;
    }
    this.hasPending();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
