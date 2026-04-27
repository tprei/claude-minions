import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "../util/classnames.js";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  children: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  default: "btn",
  primary: "btn-primary",
  ghost: "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-fg-muted hover:text-fg hover:bg-bg-elev transition-colors",
  danger: "btn border-red-700 bg-bg-soft text-red-400 hover:bg-red-900/40",
};

export function Button({ variant = "default", size, className, children, ...rest }: ButtonProps): ReactElement {
  return (
    <button
      {...rest}
      className={cx(
        variantClass[variant],
        size === "sm" && "text-xs px-2 py-1",
        className,
      )}
    >
      {children}
    </button>
  );
}
