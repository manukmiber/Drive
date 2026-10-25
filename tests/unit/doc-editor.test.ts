// Document editor (ADR-051): what the editor writes as .docx reads back with its structure.
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { writeDocx } from '../../src/web/editors/doc/write';

describe('documents', () => {
  it('writes the editor’s HTML as a Word file that keeps headings, marks, lists and tables', async () => {
    const html =
      '<h1>Laporan</h1><p>Naik <strong>12%</strong> <em>bulan ini</em> <u>pasti</u></p>' +
      '<ul><li><p>Jakarta</p><ul><li><p>Pusat</p></li></ul></li><li><p>Bandung</p></li></ul>' +
      '<ol><li><p>satu</p></li></ol>' +
      '<table><tbody><tr><th><p>Kota</p></th><th><p>Total</p></th></tr><tr><td colspan="2"><p>gabung</p></td></tr></tbody></table>';
    const blob = await writeDocx(html, 'Laporan');
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const back = await mammoth.convertToHtml(
      { buffer: Buffer.from(await blob.arrayBuffer()) },
      { styleMap: ['u => u'] },
    );
    expect(back.value).toContain('<h1>Laporan</h1>');
    expect(back.value).toContain('<strong>12%</strong>');
    expect(back.value).toContain('<u>pasti</u>');
    expect(back.value).toContain(
      '<ul><li>Jakarta<ul><li>Pusat</li></ul></li><li>Bandung</li></ul>',
    );
    expect(back.value).toContain('<ol><li>satu</li></ol>');
    expect(back.value).toContain('<td colspan="2"><p>gabung</p></td>');
  });
});
