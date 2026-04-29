import { marked } from "marked";
import DOMPurify from "dompurify";
import { cx } from "../util/classnames.js";
import { highlight } from "./highlight.js";
import "./highlight.css";

marked.use({
  renderer: {
    code({ text, lang }) {
      const language = lang || "plaintext";
      return `<pre><code class="hljs language-${language}">${highlight(text, lang)}</code></pre>`;
    },
  },
});

interface Props {
  text: string;
  className?: string;
}

export function MarkdownView({ text, className }: Props) {
  const raw = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  return (
    <div
      className={cx("markdown-view break-words leading-snug space-y-1.5", className)}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
