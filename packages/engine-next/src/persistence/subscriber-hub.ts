// Subscriber registration into the per-workflow Set<Subscriber> MUST happen
// synchronously inside [Symbol.asyncIterator](), before the first await and
// before replay() is called. Any notify() between registration and replay lands
// in the buffer; the cursor <= lastYielded dedup guard handles the overlap.
import type { WorkflowEvent } from "../domain/events.js";

interface Subscriber {
  buffer: WorkflowEvent[];
  resolve: (() => void) | undefined;
  aborted: boolean;
  abort: () => void;
}

export class SubscriberHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(
    workflowId: string,
    fromCursor: number,
    replay: () => Promise<WorkflowEvent[]>,
  ): AsyncIterable<WorkflowEvent> {
    const hub = this;
    return {
      [Symbol.asyncIterator]() {
        const sub: Subscriber = {
          buffer: [],
          resolve: undefined,
          aborted: false,
          abort() {
            this.aborted = true;
            if (this.resolve) {
              const r = this.resolve;
              this.resolve = undefined;
              r();
            }
          },
        };

        // Registration MUST be synchronous here — before the first await.
        let subSet = hub.subscribers.get(workflowId);
        if (!subSet) {
          subSet = new Set();
          hub.subscribers.set(workflowId, subSet);
        }
        subSet.add(sub);

        async function* gen(): AsyncGenerator<WorkflowEvent> {
          try {
            let lastYielded = fromCursor;
            const replayed = await replay();
            for (const event of replayed) {
              if (sub.aborted) return;
              yield event;
              lastYielded = event.cursor;
            }

            while (!sub.aborted) {
              while (sub.buffer.length > 0) {
                const event = sub.buffer.shift()!;
                // transient frames bypass cursor dedup; durable backbone is the resume truth
                if (event.kind === "provider-event" || event.kind === "merge-phase") {
                  yield event;
                  continue;
                }
                if (event.cursor <= lastYielded) continue;
                if (sub.aborted) return;
                yield event;
                lastYielded = event.cursor;
              }
              if (sub.aborted) return;
              await new Promise<void>((r) => {
                sub.resolve = r;
              });
            }
          } finally {
            const set = hub.subscribers.get(workflowId);
            if (set) {
              set.delete(sub);
              if (set.size === 0) hub.subscribers.delete(workflowId);
            }
          }
        }

        const generator = gen();

        function cleanup() {
          const set = hub.subscribers.get(workflowId);
          if (set) {
            set.delete(sub);
            if (set.size === 0) hub.subscribers.delete(workflowId);
          }
        }

        const originalReturn = generator.return.bind(generator);
        return {
          next: generator.next.bind(generator),
          return(value?: unknown) {
            sub.abort();
            cleanup();
            return originalReturn(value as WorkflowEvent);
          },
          throw: generator.throw.bind(generator),
          [Symbol.asyncIterator]() { return this; },
        };
      },
    };
  }

  notify(workflowId: string, events: WorkflowEvent[]): void {
    const subs = this.subscribers.get(workflowId);
    if (!subs || events.length === 0) return;
    for (const sub of Array.from(subs)) {
      for (const event of events) {
        sub.buffer.push(event);
      }
      if (sub.resolve) {
        const resolve = sub.resolve;
        sub.resolve = undefined;
        resolve();
      }
    }
  }

  notifyTransient(workflowId: string, event: Extract<WorkflowEvent, { kind: "provider-event" | "merge-phase" }>): void {
    const subs = this.subscribers.get(workflowId);
    if (!subs) return;
    for (const sub of Array.from(subs)) {
      sub.buffer.push(event);
      if (sub.resolve) {
        const resolve = sub.resolve;
        sub.resolve = undefined;
        resolve();
      }
    }
  }

  subscriberCount(workflowId: string): number {
    return this.subscribers.get(workflowId)?.size ?? 0;
  }
}
