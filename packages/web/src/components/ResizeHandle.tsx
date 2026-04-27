import { useRef, useCallback, type ReactElement } from "react";
import { cx } from "../util/classnames.js";

type ResizeDirection = "horizontal" | "vertical";

interface ResizeHandleProps {
  direction?: ResizeDirection;
  onDrag: (delta: number) => void;
  className?: string;
}

export function ResizeHandle({ direction = "horizontal", onDrag, className }: ResizeHandleProps): ReactElement {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragging.current = true;
    lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  }, [direction]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const pos = direction === "horizontal" ? e.clientX : e.clientY;
    const delta = pos - lastPos.current;
    lastPos.current = pos;
    if (delta !== 0) onDrag(delta);
  }, [direction, onDrag]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  return (
    <div
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cx(
        "group flex-shrink-0 select-none touch-none relative z-10",
        direction === "horizontal"
          ? "w-1.5 -mx-0.5 cursor-col-resize"
          : "h-1.5 -my-0.5 cursor-row-resize",
        className,
      )}
    >
      <div
        className={cx(
          "absolute inset-0 m-auto bg-border group-hover:bg-accent group-active:bg-accent transition-colors",
          direction === "horizontal" ? "w-px h-full" : "h-px w-full",
        )}
      />
    </div>
  );
}
