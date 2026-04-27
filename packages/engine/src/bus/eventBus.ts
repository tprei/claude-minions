import type { ServerEvent, ServerEventKind } from "@minions/shared";

type Listener<T> = (event: T) => void;
type AnyListener = Listener<ServerEvent>;
type KindListener<K extends ServerEventKind> = Listener<Extract<ServerEvent, { kind: K }>>;

export class EventBus {
  private byKind = new Map<ServerEventKind, Set<AnyListener>>();
  private anyListeners = new Set<AnyListener>();

  on<K extends ServerEventKind>(kind: K, fn: KindListener<K>): () => void {
    let bucket = this.byKind.get(kind);
    if (!bucket) {
      bucket = new Set();
      this.byKind.set(kind, bucket);
    }
    bucket.add(fn as AnyListener);
    return () => bucket?.delete(fn as AnyListener);
  }

  onAny(fn: AnyListener): () => void {
    this.anyListeners.add(fn);
    return () => this.anyListeners.delete(fn);
  }

  emit(event: ServerEvent): void {
    const bucket = this.byKind.get(event.kind);
    if (bucket) {
      for (const fn of bucket) {
        try {
          fn(event);
        } catch (e) {
          process.stderr.write(`[bus] listener error for ${event.kind}: ${(e as Error).message}\n`);
        }
      }
    }
    for (const fn of this.anyListeners) {
      try {
        fn(event);
      } catch (e) {
        process.stderr.write(`[bus] any listener error: ${(e as Error).message}\n`);
      }
    }
  }
}
