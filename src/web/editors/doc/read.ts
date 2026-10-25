// Word files into the document editor (ADR-051): mammoth reads a .docx into plain, meaningful HTML
// (headings, lists, tables, images, links; not fonts, colours, alignment or page layout), cleaned
// before the editor gets it.
import mammoth from 'mammoth';
import { cleanHtml } from '../sanitize';

const STYLE_MAP = [
  'u => u',
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
];

/**
 * Word's checkbox lists come out as `<li><input type=checkbox> …`; the editor has task lists. A list
 * with only some boxes keeps them as ☑/☐ in its text.
 */
function taskLists(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const ul of doc.querySelectorAll('ul')) {
    const items = [...ul.children].filter((c) => c.tagName === 'LI');
    const boxes = items.map((li) => li.querySelector(':scope > input[type="checkbox"]'));
    if (!boxes.some(Boolean)) continue;
    if (boxes.some((b) => !b)) {
      for (const b of boxes) b?.replaceWith(b.hasAttribute('checked') ? '☑' : '☐');
      continue;
    }
    ul.setAttribute('data-type', 'taskList');
    items.forEach((li, i) => {
      const box = boxes[i] as HTMLInputElement;
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', String(box.hasAttribute('checked')));
      box.remove();
      const p = doc.createElement('p');
      // The item's own text and marks go in a paragraph; lists inside it stay after.
      while (
        li.firstChild &&
        !(li.firstChild instanceof Element && /^(UL|OL)$/.test(li.firstChild.tagName))
      )
        p.appendChild(li.firstChild);
      li.prepend(p);
    });
  }
  return doc.body.innerHTML;
}

export async function readDocx(blob: Blob): Promise<{ html: string; lossy: boolean }> {
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await blob.arrayBuffer() },
    { styleMap: STYLE_MAP },
  );
  return { html: cleanHtml(taskLists(result.value)), lossy: result.messages.length > 0 };
}
