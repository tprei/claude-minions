import { Marked } from "marked";
import { cx } from "../util/classnames.js";
import { highlight, languageClassName } from "./highlight.js";
import { sanitizeMarkdownHtml } from "./sanitize.js";
import "./highlight.css";

const marked = new Marked({
  renderer: {
    code({ text, lang }) {
      const language = languageClassName(lang);
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
  const clean = sanitizeMarkdownHtml(raw);
  return (
    <div
      className={cx("markdown-view break-words leading-snug space-y-1.5", className)}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}
