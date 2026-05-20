import createDOMPurify, { type Config, type DOMPurify as DOMPurifyInstance } from "dompurify";

const FORBID_TAGS = [
  "base",
  "button",
  "canvas",
  "details",
  "dialog",
  "embed",
  "fieldset",
  "form",
  "iframe",
  "input",
  "label",
  "link",
  "meta",
  "object",
  "optgroup",
  "option",
  "script",
  "select",
  "style",
  "summary",
  "textarea",
] satisfies string[];

const FORBID_TAG_SET = new Set(FORBID_TAGS);

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
  ],
  ALLOWED_ATTR: ["class", "href", "rel", "title"],
  FORBID_TAGS,
  FORBID_ATTR: ["style"],
} satisfies Config;

let hooksInstalled = false;
let purify: DOMPurifyInstance | null = null;

function getPurify(): DOMPurifyInstance {
  if (!purify) {
    purify = typeof window === "undefined" ? createDOMPurify : createDOMPurify(window);
  }
  return purify;
}

function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value === "") return false;
  if (/\p{Cc}/u.test(value)) return false;
  if (value.startsWith("#") || (value.startsWith("/") && !value.startsWith("//"))) {
    return true;
  }
  if (value.startsWith("./") || value.startsWith("../") || value.startsWith("?")) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

function isExternalHref(href: string): boolean {
  try {
    const base =
      typeof window === "undefined" ? "https://minions.local/" : window.location.href;
    const url = new URL(href, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (typeof window === "undefined") return true;
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

function installHooks(): void {
  if (hooksInstalled) return;
  const domPurify = getPurify();
  domPurify.addHook("uponSanitizeElement", (node, data) => {
    if (FORBID_TAG_SET.has(data.tagName)) {
      node.parentNode?.removeChild(node);
    }
  });
  domPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeType === 1) {
      (node as Element).removeAttribute("style");
    }
    if (node.nodeName !== "A") return;
    const element = node as Element;
    const href = element.getAttribute("href");
    if (!href || !isSafeHref(href)) {
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.removeAttribute("rel");
      return;
    }
    if (isExternalHref(href)) {
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }
  });
  hooksInstalled = true;
}

function hardenSanitizedHtml(html: string): string {
  if (typeof document === "undefined") return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const tag of FORBID_TAGS) {
    for (const node of Array.from(template.content.querySelectorAll(tag))) {
      node.parentNode?.removeChild(node);
    }
  }
  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    element.removeAttribute("style");
    if (element.nodeName !== "A") continue;
    const href = element.getAttribute("href");
    if (!href || !isSafeHref(href)) {
      element.removeAttribute("href");
      element.removeAttribute("target");
      element.removeAttribute("rel");
    } else if (isExternalHref(href)) {
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }
  return template.innerHTML;
}

export function sanitizeMarkdownHtml(html: string): string {
  installHooks();
  const domPurify = getPurify();
  domPurify.setConfig(SANITIZE_CONFIG);
  return hardenSanitizedHtml(domPurify.sanitize(html));
}
