import { useState } from "react";
import DOMPurify from "dompurify";
import { cx } from "../util/classnames.js";
import { highlight } from "./highlight.js";
import "./highlight.css";

interface Props {
  code: string;
  language?: string;
  className?: string;
  copy?: boolean;
}

export function CodeBlock({ code, language, className, copy = true }: Props) {
  const [copied, setCopied] = useState(false);
  const html = DOMPurify.sanitize(highlight(code, language), { USE_PROFILES: { html: true } });
  const lang = language || "plaintext";

  function onCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className={cx("relative rounded-md border border-border bg-bg-soft", className)}>
      {copy ? (
        <button
          type="button"
          onClick={onCopy}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded border border-border bg-bg-soft text-fg-subtle hover:text-fg hover:bg-bg-elev transition-colors"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      ) : null}
      <pre className="overflow-x-auto p-3 text-[12px] leading-snug">
        <code
          className={`hljs language-${lang}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  );
}
