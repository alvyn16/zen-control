/**
 * A Stop press that could not be delivered to the host yet (socket down or
 * handshake still in progress), kept until the connection becomes usable.
 *
 * Only one progress card exists at a time and its Stop button disables after a
 * press, so a single slot is sufficient. A newer press replaces an older one;
 * the store can never grow without bound.
 */

export interface PendingStop {
  progressId: string;
  ts: number;
}

/** Return false from the sender to keep the press queued for the next retry. */
export type StopSender = (stop: PendingStop) => boolean;

export class PendingStopStore {
  #pending: PendingStop | null = null;

  get size(): number {
    return this.#pending ? 1 : 0;
  }

  set(progressId: string, ts: number = Date.now()): void {
    if (!progressId) return;
    this.#pending = { progressId, ts };
  }

  peek(): PendingStop | null {
    return this.#pending ? { ...this.#pending } : null;
  }

  clear(): void {
    this.#pending = null;
  }

  /**
   * Drops a queued press when its card was cleared (null) or replaced by a
   * different progress id. Stops belonging to replaced cards must not be
   * delivered later.
   */
  clearIfProgressMoved(progressId: string | null): void {
    if (this.#pending && this.#pending.progressId !== progressId) {
      this.#pending = null;
    }
  }
}

/**
 * Attempts one delivery. A successful send clears older presses; a failure
 * replaces the slot with a fresh press so it can be retried on reconnect.
 */
export function deliverStop(
  store: PendingStopStore,
  progressId: string,
  sender: StopSender,
  ts: number = Date.now()
): boolean {
  if (sender({ progressId, ts })) {
    store.clear();
    return true;
  }
  store.set(progressId, ts);
  return false;
}
