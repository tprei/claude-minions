import { useEffect, useRef } from "react";

interface SwipeToDismissOptions {
  threshold?: number;
  direction?: "left" | "right" | "down" | "up";
}

export function useSwipeToDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  opts: SwipeToDismissOptions = {}
): void {
  const threshold = opts.threshold ?? 60;
  const direction = opts.direction ?? "down";

  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function onPointerDown(e: PointerEvent) {
      startRef.current = { x: e.clientX, y: e.clientY };
    }

    function onPointerUp(e: PointerEvent) {
      if (!startRef.current) return;
      const dx = e.clientX - startRef.current.x;
      const dy = e.clientY - startRef.current.y;
      startRef.current = null;

      const exceeded =
        (direction === "down" && dy > threshold) ||
        (direction === "up" && -dy > threshold) ||
        (direction === "right" && dx > threshold) ||
        (direction === "left" && -dx > threshold);

      if (exceeded) onDismiss();
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
    };
  }, [ref, onDismiss, threshold, direction]);
}

interface EdgeSwipeOptions {
  edge?: "left" | "right";
  threshold?: number;
  edgeWidth?: number;
}

export function useEdgeSwipe(
  ref: React.RefObject<HTMLElement | null>,
  onTrigger: () => void,
  opts: EdgeSwipeOptions = {},
): void {
  const edge = opts.edge ?? "left";
  const threshold = opts.threshold ?? 60;
  const edgeWidth = opts.edgeWidth ?? 20;

  const startRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function onPointerDown(e: PointerEvent) {
      const target = el;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const fromLeft = e.clientX - rect.left;
      const fromRight = rect.right - e.clientX;
      const armed = edge === "left" ? fromLeft <= edgeWidth : fromRight <= edgeWidth;
      if (armed) {
        startRef.current = { x: e.clientX, y: e.clientY };
      } else {
        startRef.current = null;
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!startRef.current) return;
      const dx = e.clientX - startRef.current.x;
      startRef.current = null;
      const exceeded = edge === "left" ? dx > threshold : -dx > threshold;
      if (exceeded) onTrigger();
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
    };
  }, [ref, onTrigger, edge, threshold, edgeWidth]);
}

interface PullToRefreshOptions {
  threshold?: number;
}

export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => void | Promise<void>,
  opts: PullToRefreshOptions = {}
): void {
  const threshold = opts.threshold ?? 60;
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function onPointerDown(e: PointerEvent) {
      if (el && el.scrollTop === 0) {
        startRef.current = { x: e.clientX, y: e.clientY };
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (!startRef.current || refreshingRef.current) return;
      const dy = e.clientY - startRef.current.y;
      startRef.current = null;

      if (dy > threshold) {
        refreshingRef.current = true;
        const result = onRefresh();
        if (result instanceof Promise) {
          void result.finally(() => { refreshingRef.current = false; });
        } else {
          refreshingRef.current = false;
        }
      }
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
    };
  }, [ref, onRefresh, threshold]);
}
