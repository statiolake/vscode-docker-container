export class BusySet {
  private readonly keys = new Set<string>();

  public set(key: string, busy: boolean): void {
    if (busy) {
      this.keys.add(key);
      return;
    }

    this.keys.delete(key);
  }

  public has(key: string): boolean {
    return this.keys.has(key);
  }
}
