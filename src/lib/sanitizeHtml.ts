import DOMPurify from "dompurify";

/**
 * Job description HTML comes from external ATS APIs / scraped career pages — untrusted content
 * that must never be rendered raw via dangerouslySetInnerHTML. Client-side only (DOMPurify needs
 * a real DOM); returns the input unsanitized during SSR since these components render client-side.
 */
let hookInstalled = false;

function ensureSafeLinkHook() {
  if (hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  hookInstalled = true;
}

export function sanitizeJobHtml(html: string): string {
  if (typeof window === "undefined") return "";
  ensureSafeLinkHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "div", "span", "strong", "b", "em", "i", "u", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "a", "blockquote", "hr", "table", "thead",
      "tbody", "tr", "td", "th",
    ],
    ALLOWED_ATTR: ["href", "target", "rel"],
    ALLOW_DATA_ATTR: false,
  });
}
