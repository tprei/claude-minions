export interface SseEvent {
  event: string;
  data: unknown;
}

export interface SseClient {
  close: () => void;
  events: AsyncIterable<SseEvent>;
}

export async function connectSseClient(url: string, token: string): Promise<SseClient> {
  const controller = new AbortController();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();

  const queue: SseEvent[] = [];
  let waiter: ((v: IteratorResult<SseEvent>) => void) | null = null;
  let closed = false;

  function deliver(ev: SseEvent): void {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  }

  function endStream(): void {
    if (closed) return;
    closed = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: undefined as unknown as SseEvent, done: true });
    }
  }

  void (async () => {
    let buffer = "";
    let event = "message";
    let dataLines: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl < 0) break;
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            if (dataLines.length > 0) {
              const raw = dataLines.join("\n");
              let data: unknown = raw;
              try {
                data = JSON.parse(raw);
              } catch {
                data = raw;
              }
              deliver({ event, data });
            }
            event = "message";
            dataLines = [];
            continue;
          }
          if (line.startsWith(":")) continue;
          const colonIdx = line.indexOf(":");
          let field: string;
          let val: string;
          if (colonIdx < 0) {
            field = line;
            val = "";
          } else {
            field = line.slice(0, colonIdx);
            val = line.slice(colonIdx + 1);
            if (val.startsWith(" ")) val = val.slice(1);
          }
          if (field === "event") event = val;
          else if (field === "data") dataLines.push(val);
        }
      }
    } catch {
      // aborted or stream errored — surface as end-of-stream
    } finally {
      endStream();
    }
  })();

  const events: AsyncIterable<SseEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<SseEvent> {
      return {
        next(): Promise<IteratorResult<SseEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift() as SseEvent, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
          }
          return new Promise((resolve) => {
            waiter = resolve;
          });
        },
        return(): Promise<IteratorResult<SseEvent>> {
          controller.abort();
          endStream();
          return Promise.resolve({ value: undefined as unknown as SseEvent, done: true });
        },
      };
    },
  };

  return {
    close: (): void => {
      controller.abort();
      endStream();
    },
    events,
  };
}
