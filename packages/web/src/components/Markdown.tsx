import { marked } from "marked";
import DOMPurify from "dompurify";
import { cx } from "../util/classnames.js";

interface Props {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: Props) {
  const raw = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  return (
    <div
      className={cx(
        "prose prose-sm prose-invert max-w-none",
        "[&_pre]:bg-zinc-900 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-x-auto",
        "[&_code]:font-mono [&_code]:text-xs",
        "[&_p]:leading-relaxed",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
