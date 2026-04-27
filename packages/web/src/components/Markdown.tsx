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
        "prose prose-sm prose-invert max-w-none leading-snug",
        "prose-p:my-1.5 prose-headings:my-2 prose-li:my-0.5 prose-ul:my-1 prose-ol:my-1",
        "prose-pre:my-2 prose-pre:p-2 prose-pre:rounded prose-pre:bg-bg-soft prose-pre:text-fg prose-pre:overflow-x-auto",
        "prose-code:before:hidden prose-code:after:hidden prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] prose-code:rounded prose-code:bg-bg-soft prose-code:text-fg",
        "break-words",
        className,
      )}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
