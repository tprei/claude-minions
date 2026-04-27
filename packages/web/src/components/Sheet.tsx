import { useEffect, type ReactElement, type ReactNode } from "react";
import { cx } from "../util/classnames.js";

type SheetSide = "bottom" | "right" | "left";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  side?: SheetSide;
  title?: string;
  children: ReactNode;
  className?: string;
}

const sideClass: Record<SheetSide, string> = {
  bottom: "inset-x-0 bottom-0 rounded-t-2xl max-h-[80dvh] overflow-y-auto",
  right: "right-0 top-0 bottom-0 w-full max-w-sm overflow-y-auto",
  left: "left-0 top-0 bottom-0 w-full max-w-sm overflow-y-auto",
};

const slideIn: Record<SheetSide, string> = {
  bottom: "translate-y-0",
  right: "translate-x-0",
  left: "translate-x-0",
};

const slideOut: Record<SheetSide, string> = {
  bottom: "translate-y-full",
  right: "translate-x-full",
  left: "-translate-x-full",
};

export function Sheet({ open, onClose, side = "bottom", title, children, className }: SheetProps): ReactElement {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  return (
    <div
      className={cx(
        "fixed inset-0 z-40 transition-all duration-300",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <div
        className={cx(
          "absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={cx(
          "absolute card shadow-2xl transition-transform duration-300",
          sideClass[side],
          open ? slideIn[side] : slideOut[side],
          className,
        )}
      >
        <div className="p-4">
          {title && (
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-fg">{title}</h2>
              <button
                onClick={onClose}
                className="text-fg-subtle hover:text-fg transition-colors p-1 rounded"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
