/**
 * A simple async queue: producers `push()`, consumers iterate via async iterator.
 * Used to feed Slack thread replies into a Claude session's `streamInput`.
 *
 * - `push()` is non-blocking. If a consumer is waiting, it resolves immediately;
 *   otherwise the value is buffered.
 * - Iteration ends when `close()` is called and the buffer is drained.
 * - `error()` causes the iterator to throw, surfacing the error to the consumer.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<{ resolve: (v: IteratorResult<T>) => void; reject: (e: unknown) => void }> = [];
  private closed = false;
  private err: unknown = undefined;

  push(value: T): void {
    if (this.closed) throw new Error("AsyncQueue: push after close");
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
    } else {
      this.buffer.push(value);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined, done: true });
    }
  }

  error(err: unknown): void {
    if (this.closed) return;
    this.err = err;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.reject(err);
    }
  }

  size(): number {
    return this.buffer.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.err !== undefined) return Promise.reject(this.err);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
