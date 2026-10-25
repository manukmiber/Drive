// Text files in and out of the editor (ADR-051): UTF-8 only, and a byte-order mark and Windows line
// endings come back out the way they went in.

export interface TextFile {
  text: string;
  bom: boolean;
  crlf: boolean;
}

export class NotTextError extends Error {
  constructor() {
    super('NOT_TEXT');
  }
}

export function decodeText(bytes: Uint8Array): TextFile {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    throw new NotTextError();
  }
  // A NUL is no letter: this is a program or a picture with a text name.
  if (text.includes('\0')) throw new NotTextError();
  // The first line break decides; the editor joins lines with "\n" and the save puts "\r\n" back.
  const nl = text.search(/\r?\n/);
  return { text, bom, crlf: nl >= 0 && text[nl] === '\r' };
}

export function encodeText(text: string, f: Omit<TextFile, 'text'>, type: string): Blob {
  const body = f.crlf ? text.replace(/\r?\n/g, '\r\n') : text;
  return new Blob(f.bom ? ['﻿', body] : [body], { type });
}
