// HTML made from people's files (Markdown, .docx) is cleaned before it reaches the page (ADR-051).
// The app's CSP already refuses inline scripts; this also drops event handlers, forms, frames and
// links that are not web or mail addresses, and opens links in a new tab.
import DOMPurify from 'dompurify';

const SAFE_LINK = /^(https?:|mailto:|#)/i;

// Set up on first use, so importing this needs no page (tests of the converters run without one).
let hooked = false;
function purify() {
  if (hooked) return DOMPurify;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href');
    if (href && !SAFE_LINK.test(href.trim())) node.removeAttribute('href');
    if (node.getAttribute('href')?.startsWith('#')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  hooked = true;
  return DOMPurify;
}

const OPTIONS = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
};

export function cleanHtml(html: string): string {
  return purify().sanitize(html, OPTIONS);
}

/** Cleans a rendered element where it is (keeps its `<style>`, which docx-preview needs). */
export function cleanInPlace(el: HTMLElement): void {
  purify().sanitize(el, { ...OPTIONS, IN_PLACE: true, ADD_TAGS: ['style'] });
}
