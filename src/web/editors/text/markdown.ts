// The Markdown preview (ADR-051): GitHub-style Markdown, cleaned before it is shown.
import { marked } from 'marked';
import { cleanHtml } from '../sanitize';

export function markdownHtml(src: string): string {
  return cleanHtml(marked.parse(src, { async: false, gfm: true }));
}
