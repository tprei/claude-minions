export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let handle: NodeJS.Timeout | null = null;
  let lastArgs: A | null = null;
  return (...args: A) => {
    lastArgs = args;
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      if (lastArgs) fn(...lastArgs);
    }, ms);
  };
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let last = 0;
  let pending: A | null = null;
  let handle: NodeJS.Timeout | null = null;
  return (...args: A) => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...args);
    } else {
      pending = args;
      if (!handle) {
        handle = setTimeout(() => {
          handle = null;
          last = Date.now();
          if (pending) fn(...pending);
          pending = null;
        }, ms - (now - last));
      }
    }
  };
}
