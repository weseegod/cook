import type { SessionNotification } from "@agentclientprotocol/sdk";

export type ScheduleFlush = (flush: () => void) => void;

function scheduleOnNextFrame(flush: () => void): void {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(flush);
    return;
  }
  globalThis.setTimeout(flush, 16);
}

/**
 * Coalesces session updates without changing reducer semantics. The live client supplies the
 * browser frame scheduler; tests can retain the callback and invoke it synchronously.
 */
export class SessionNotificationCoalescer {
  private pending: SessionNotification[] = [];
  private scheduled = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly apply: (notifications: SessionNotification[]) => void,
    private readonly scheduleFlush: ScheduleFlush = scheduleOnNextFrame,
  ) {}

  enqueue(notification: SessionNotification): void {
    this.pending.push(notification);
    if (this.scheduled) return;
    this.scheduled = true;
    this.scheduleFlush(() => {
      this.scheduled = false;
      this.flushNow();
    });
  }

  /** Flushes synchronously at ordering boundaries or before a prompt turn is finalized. */
  flushNow(): void {
    if (this.pending.length === 0) {
      this.resolveWaiters();
      return;
    }
    const notifications = this.pending;
    this.pending = [];
    this.apply(notifications);
    this.resolveWaiters();
  }

  waitForFlush(): Promise<void> {
    if (this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
