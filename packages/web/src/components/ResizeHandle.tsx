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

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastPos.current = direction === "horizontal" ? e.clientX : e.clientY;

    const onMove = (ev: MouseEvent): void => {
      if (!dragging.current) return;
      const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      onDrag(delta);
    };

    const onUp = (): void => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [direction, onDrag]);

  return (
    <div
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      className={cx(
        "flex-shrink-0 bg-border hover:bg-accent transition-colors select-none",
        direction === "horizontal"
          ? "w-px cursor-col-resize hover:w-0.5"
          : "h-px cursor-row-resize hover:h-0.5",
        className,
      )}
      onMouseDown={onMouseDown}
    />
  );
}
