/** A bounded FIFO: waiting jobs keep their original deadline and never open a socket. */
export class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly concurrent: number, private readonly maxQueued: number) {}

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.active < this.concurrent) this.active++;
    else {
      if (this.queue.length >= this.maxQueued) throw new Error('Upstream request capacity reached; retry later');
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => {
          this.queue = this.queue.filter((x) => x !== ready);
          reject(signal.reason);
        };
        this.queue.push(ready);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    try { signal.throwIfAborted(); return await task(); }
    finally {
      const next = this.queue.shift();
      if (next) next();   // pass this slot directly to the next waiter
      else this.active--;
    }
  }
}
