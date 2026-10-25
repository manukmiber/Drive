// The document editor's files out (ADR-051): docx/html writes the editor's HTML as a .docx, and a
// web page of its own. Nothing here needs a page, so the tests run it.
import { Document, Packer } from 'docx';
import { htmlToContent } from 'docx/html';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function writeDocx(html: string, title: string): Promise<Blob> {
  const doc = new Document({
    title,
    sections: [{ children: [...htmlToContent(html)] }],
  });
  return new Blob([await Packer.toBlob(doc)], { type: DOCX_MIME });
}

const escape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A web page of its own, readable without the app. */
export function htmlPage(body: string, title: string, lang: string): Blob {
  const page = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.65 system-ui, sans-serif; color: #111827; }
table { border-collapse: collapse; } th, td { border: 1px solid #cbd5e1; padding: .35em .6em; vertical-align: top; }
img { max-width: 100%; height: auto; } blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #cbd5e1; color: #475569; }
pre { overflow-x: auto; background: #f1f5f9; padding: .8em 1em; border-radius: .5rem; }
ul[data-type="taskList"] { list-style: none; padding-left: .2em; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
  return new Blob([page], { type: 'text/html' });
}
