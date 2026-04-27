import { useRef, useCallback, type ReactElement } from "react";
import { cx } from "../util/classnames.js";

type ResizeDirection = "horizontal" | "vertical";

interface ResizeHandleProps {
  direction?: ResizeDirection;
  onDrag: (delta: number) => void;
  className?: string;
}

export function ResizeHandle({ direction = "horizontal", onDrag, className }: ResizeHandleProps): ReactElement {
  const lastPos = useRef(0);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      ev.preventDefault();
      const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      if (delta !== 0) onDragRef.current(delta);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }, [direction]);

  return (
    <div
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
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
