/**
 * Simple busy lock to prevent concurrent tool calls during long-running operations.
 */

export class BusyLock {
  private _busy = false;
  private _holder: string | null = null;

  get isBusy(): boolean {
    return this._busy;
  }

  get holder(): string | null {
    return this._holder;
  }

  acquire(holder: string): void {
    if (this._busy) {
      throw new Error(`Lock already held by "${this._holder}"`);
    }
    this._busy = true;
    this._holder = holder;
  }

  release(): void {
    this._busy = false;
    this._holder = null;
  }
}
