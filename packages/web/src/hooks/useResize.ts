import { useState, useEffect, useRef, type RefObject } from "react";

export interface DOMRect {
  width: number;
  height: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export function useResize<T extends Element = Element>(): [RefObject<T>, DOMRect | null] {
  const ref = useRef<T>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const r = entry.contentRect;
      setRect({ width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom });
    });

    observer.observe(el);
    const r = el.getBoundingClientRect();
    setRect({ width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom });

    return () => observer.disconnect();
  }, []);

  return [ref, rect];
}
