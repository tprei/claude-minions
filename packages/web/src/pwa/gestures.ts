import { useEffect, useRef, useState } from "react";
import { vibrate } from "./haptics.js";
import { isReducedMotion } from "./motion.js";

export function hasScrollableAncestor(
  target: EventTarget | null,
  root: HTMLElement,
  axis: "x" | "y",
): boolean {
  if (!target || !(target instanceof Element)) return false;
  let node: Element | null = target;
  while (node && node !== root) {
    if (node instanceof HTMLElement) {
      const style = getComputedStyle(node);
      const overflow = axis === "x" ? style.overflowX : style.overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        const scrolls =
          axis === "x"
            ? node.scrollWidth > node.clientWidth
            : node.scrollHeight > node.clientHeight;
        if (scrolls) return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

interface DragToDismissOptions {
  direction: "down" | "up" | "left" | "right";
  threshold?: number;
  velocityThreshold?: number;
  rubberBandFactor?: number;
  enabled?: () => boolean;
}

interface DragToDismissState {
  dragging: boolean;
  offset: number;
  progress: number;
  axis: "x" | "y";
}

export function useDragToDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  opts: DragToDismissOptions,
): DragToDismissState {
  const direction = opts.direction;
  const threshold = opts.threshold ?? 80;
  const velocityThreshold = opts.velocityThreshold ?? 0.5;
  const rubberBandFactor = opts.rubberBandFactor ?? 0.4;
  const axis: "x" | "y" = direction === "left" || direction === "right" ? "x" : "y";

  const enabledRef = useRef<(() => boolean) | undefined>(opts.enabled);
  enabledRef.current = opts.enabled;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const [state, setState] = useState<DragToDismissState>({
    dragging: false,
    offset: 0,
    progress: 0,
    axis,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reducedMotion = isReducedMotion();
    const sign = direction === "down" || direction === "right" ? 1 : -1;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let engaged = false;
    let currentOffset = 0;
    let hapticFired = false;
    let samples: { t: number; v: number }[] = [];
    let frameRaf: number | null = null;
    let pendingOffset = 0;
    let snapRaf: number | null = null;
    let cancelled = false;

    function dirOffset(dx: number, dy: number): number {
      return (axis === "y" ? dy : dx) * sign;
    }

    function detachWindow(): void {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("pointerup", onPointerUpReduced);
    }

    function cancelSnap(): void {
      if (snapRaf !== null) {
        cancelAnimationFrame(snapRaf);
        snapRaf = null;
      }
    }

    function clearGesture(): void {
      pointerId = null;
      engaged = false;
      currentOffset = 0;
      hapticFired = false;
      samples = [];
      pendingOffset = 0;
      if (frameRaf !== null) {
        cancelAnimationFrame(frameRaf);
        frameRaf = null;
      }
    }

    function flushFrame(): void {
      frameRaf = null;
      if (cancelled) return;
      const progress = Math.min(1, Math.max(0, pendingOffset / threshold));
      if (progress >= 1 && !hapticFired) {
        hapticFired = true;
        vibrate(10);
      }
      setState({ dragging: true, offset: pendingOffset, progress, axis });
    }

    function scheduleFrame(): void {
      if (frameRaf !== null) return;
      frameRaf = requestAnimationFrame(flushFrame);
    }

    function snapBack(from: number): void {
      const start = performance.now();
      const duration = 200;
      function step(now: number): void {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const offset = from * (1 - eased);
        const progress = Math.min(1, Math.max(0, offset / threshold));
        setState({ dragging: false, offset, progress, axis });
        if (t < 1) snapRaf = requestAnimationFrame(step);
        else snapRaf = null;
      }
      snapRaf = requestAnimationFrame(step);
    }

    function computeVelocity(): number {
      if (samples.length < 2) return 0;
      const oldest = samples[0]!;
      const newest = samples[samples.length - 1]!;
      const dt = newest.t - oldest.t;
      if (dt <= 0) return 0;
      return (newest.v - oldest.v) / dt;
    }

    function onPointerDown(e: PointerEvent): void {
      if (pointerId !== null) return;
      const gate = enabledRef.current;
      if (gate && !gate()) return;
      cancelSnap();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      engaged = false;
      currentOffset = 0;
      hapticFired = false;
      samples = [];
      pendingOffset = 0;

      if (reducedMotion) {
        window.addEventListener("pointerup", onPointerUpReduced);
        return;
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    }

    function onPointerMove(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const primary = Math.abs(axis === "y" ? dy : dx);
      const orth = Math.abs(axis === "y" ? dx : dy);

      if (!engaged) {
        if (primary <= 8) return;
        if (primary < orth) {
          detachWindow();
          clearGesture();
          return;
        }
        if (hasScrollableAncestor(e.target, el!, axis)) {
          detachWindow();
          clearGesture();
          return;
        }
        engaged = true;
        try {
          el!.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }

      const signed = dirOffset(dx, dy);
      let offset: number;
      if (signed >= 0) {
        offset = signed;
      } else {
        const abs = Math.abs(signed);
        offset = -Math.sqrt(abs) * rubberBandFactor * 8;
      }
      currentOffset = offset;
      pendingOffset = offset;

      samples.push({ t: e.timeStamp, v: offset });
      const cutoff = e.timeStamp - 50;
      while (samples.length > 1 && samples[0]!.t < cutoff) samples.shift();

      scheduleFrame();
    }

    function onPointerUp(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const rawOffset = dirOffset(dx, dy);
      detachWindow();

      if (!engaged) {
        if (rawOffset > threshold) onDismissRef.current();
        clearGesture();
        return;
      }

      const v = computeVelocity();
      const exceeded = currentOffset >= threshold || v > velocityThreshold;
      if (exceeded) {
        vibrate(10);
        if (!cancelled) {
          setState({ dragging: false, offset: currentOffset, progress: 1, axis });
        }
        clearGesture();
        onDismissRef.current();
      } else {
        const from = currentOffset;
        clearGesture();
        snapBack(from);
      }
    }

    function onPointerCancel(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      detachWindow();
      const wasEngaged = engaged;
      const from = currentOffset;
      clearGesture();
      if (wasEngaged) snapBack(from);
    }

    function onPointerUpReduced(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const rawOffset = dirOffset(dx, dy);
      detachWindow();
      clearGesture();
      if (rawOffset > threshold) onDismissRef.current();
    }

    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelled = true;
      el.removeEventListener("pointerdown", onPointerDown);
      detachWindow();
      if (frameRaf !== null) cancelAnimationFrame(frameRaf);
      if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    };
  }, [ref, direction, threshold, velocityThreshold, rubberBandFactor, axis]);

  return state;
}

interface SwipeToDismissOptions {
  threshold?: number;
  direction?: "left" | "right" | "down" | "up";
  enabled?: () => boolean;
}

export function useSwipeToDismiss(
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  opts: SwipeToDismissOptions = {},
): void {
  useDragToDismiss(ref, onDismiss, {
    direction: opts.direction ?? "down",
    threshold: opts.threshold ?? 60,
    enabled: opts.enabled,
  });
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

interface PullToRefreshState {
  dragging: boolean;
  offset: number;
  progress: number;
  refreshing: boolean;
}

export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => void | Promise<void>,
  opts: PullToRefreshOptions = {},
): PullToRefreshState {
  const threshold = opts.threshold ?? 60;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const [state, setState] = useState<PullToRefreshState>({
    dragging: false,
    offset: 0,
    progress: 0,
    refreshing: false,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reducedMotion = isReducedMotion();
    const restOffset = threshold * 0.6;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let engaged = false;
    let currentOffset = 0;
    let hapticFired = false;
    let refreshing = false;
    let frameRaf: number | null = null;
    let pendingOffset = 0;
    let snapRaf: number | null = null;
    let cancelled = false;

    function detachWindow(): void {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("pointerup", onPointerUpReduced);
    }

    function cancelSnap(): void {
      if (snapRaf !== null) {
        cancelAnimationFrame(snapRaf);
        snapRaf = null;
      }
    }

    function clearGesture(): void {
      pointerId = null;
      engaged = false;
      currentOffset = 0;
      hapticFired = false;
      pendingOffset = 0;
      if (frameRaf !== null) {
        cancelAnimationFrame(frameRaf);
        frameRaf = null;
      }
    }

    function flushFrame(): void {
      frameRaf = null;
      if (cancelled) return;
      const progress = Math.min(1, Math.max(0, pendingOffset / threshold));
      if (progress >= 1 && !hapticFired) {
        hapticFired = true;
        vibrate(10);
      }
      setState({ dragging: true, offset: pendingOffset, progress, refreshing });
    }

    function scheduleFrame(): void {
      if (frameRaf !== null) return;
      frameRaf = requestAnimationFrame(flushFrame);
    }

    function ease(from: number, to: number, durationMs: number, after?: () => void): void {
      cancelSnap();
      if (from === to) {
        if (!cancelled) {
          const progress = Math.min(1, Math.max(0, to / threshold));
          setState({ dragging: false, offset: to, progress, refreshing });
        }
        if (after) after();
        return;
      }
      const start = performance.now();
      function step(now: number): void {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        const offset = from + (to - from) * eased;
        const progress = Math.min(1, Math.max(0, offset / threshold));
        setState({ dragging: false, offset, progress, refreshing });
        if (t < 1) {
          snapRaf = requestAnimationFrame(step);
        } else {
          snapRaf = null;
          if (after) after();
        }
      }
      snapRaf = requestAnimationFrame(step);
    }

    function runRefreshCallback(): void {
      const result = onRefreshRef.current();
      const finish = (): void => {
        refreshing = false;
        if (cancelled) return;
        if (reducedMotion) {
          setState({ dragging: false, offset: 0, progress: 0, refreshing: false });
        } else {
          ease(restOffset, 0, 200);
        }
      };
      if (result instanceof Promise) {
        void result.finally(finish);
      } else {
        finish();
      }
    }

    function triggerRefresh(fromOffset: number): void {
      vibrate(10);
      refreshing = true;
      if (reducedMotion) {
        if (!cancelled) {
          setState((s) => ({ ...s, refreshing: true }));
        }
        runRefreshCallback();
      } else {
        ease(fromOffset, restOffset, 200, runRefreshCallback);
      }
    }

    function onPointerDown(e: PointerEvent): void {
      if (pointerId !== null) return;
      if (refreshing) return;
      if (el!.scrollTop !== 0) return;
      cancelSnap();
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      engaged = false;
      currentOffset = 0;
      hapticFired = false;
      pendingOffset = 0;

      if (reducedMotion) {
        window.addEventListener("pointerup", onPointerUpReduced);
        return;
      }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    }

    function onPointerMove(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!engaged) {
        if (dy <= 8) return;
        if (dy <= Math.abs(dx)) {
          detachWindow();
          clearGesture();
          return;
        }
        if (el!.scrollTop !== 0) {
          detachWindow();
          clearGesture();
          return;
        }
        if (hasScrollableAncestor(e.target, el!, "y")) {
          detachWindow();
          clearGesture();
          return;
        }
        engaged = true;
        try {
          el!.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }

      let offset: number;
      if (dy <= 0) offset = 0;
      else if (dy <= threshold) offset = dy;
      else offset = threshold + Math.sqrt(dy - threshold) * 6;
      offset = Math.min(150, offset);

      currentOffset = offset;
      pendingOffset = offset;
      scheduleFrame();
    }

    function onPointerUp(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      detachWindow();

      if (!engaged) {
        if (dy > threshold) {
          clearGesture();
          triggerRefresh(0);
          return;
        }
        clearGesture();
        return;
      }

      const past = currentOffset >= threshold;
      const from = currentOffset;
      clearGesture();
      if (past) {
        triggerRefresh(from);
      } else {
        ease(from, 0, 200);
      }
    }

    function onPointerCancel(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      detachWindow();
      const wasEngaged = engaged;
      const from = currentOffset;
      clearGesture();
      if (wasEngaged) ease(from, 0, 200);
    }

    function onPointerUpReduced(e: PointerEvent): void {
      if (pointerId === null || e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      detachWindow();
      clearGesture();
      if (dy > threshold) triggerRefresh(0);
    }

    el.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelled = true;
      el.removeEventListener("pointerdown", onPointerDown);
      detachWindow();
      if (frameRaf !== null) cancelAnimationFrame(frameRaf);
      if (snapRaf !== null) cancelAnimationFrame(snapRaf);
    };
  }, [ref, threshold]);

  return state;
}
