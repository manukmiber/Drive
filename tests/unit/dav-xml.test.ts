// D9 (ADR-089): the little namespace-aware XML reader WebDAV bodies go through, and path handling.
import { describe, expect, it } from 'vitest';
import { clark, davResponse, multistatus, parseXml, XmlError } from '../../src/worker/lib/dav-xml';
import { davHref, splitDavPath } from '../../src/worker/services/webdav';
import { mimeFromName } from '../../src/shared/mime';

describe('dav-xml', () => {
  it('resolves prefixes and default namespaces the way clients write them', () => {
    const windows = parseXml(
      `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/><D:quota-available-bytes/></D:prop></D:propfind>`,
    );
    expect(clark(windows)).toBe('{DAV:}propfind');
    expect(windows.children[0]!.children.map(clark)).toEqual([
      '{DAV:}getcontentlength',
      '{DAV:}quota-available-bytes',
    ]);
    const rclone = parseXml(
      `<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getlastmodified/><oc:checksums/></d:prop></d:propfind>`,
    );
    expect(rclone.children[0]!.children.map(clark)).toEqual([
      '{DAV:}getlastmodified',
      '{http://owncloud.org/ns}checksums',
    ]);
    const plain = parseXml(`<propfind xmlns="DAV:"><allprop/></propfind>`);
    expect(clark(plain.children[0]!)).toBe('{DAV:}allprop');
  });

  it('reads text, entities and CDATA, and a namespace declared on the element itself', () => {
    const doc = parseXml(
      `<D:propertyupdate xmlns:D="DAV:"><D:set><D:prop>` +
        `<Z:Win32LastModifiedTime xmlns:Z="urn:schemas-microsoft-com:">Wed, 01 Jan 2025 10:00:00 GMT</Z:Win32LastModifiedTime>` +
        `<x:note xmlns:x="urn:x">a &amp; b &#x41;<![CDATA[<c>]]></x:note>` +
        `</D:prop></D:set></D:propertyupdate>`,
    );
    const props = doc.children[0]!.children[0]!.children;
    expect(clark(props[0]!)).toBe('{urn:schemas-microsoft-com:}Win32LastModifiedTime');
    expect(props[0]!.text).toBe('Wed, 01 Jan 2025 10:00:00 GMT');
    expect(props[1]!.text).toBe('a & b A<c>');
  });

  it('refuses DOCTYPE, bad nesting, unknown prefixes and oversized bodies', () => {
    expect(() => parseXml(`<!DOCTYPE x [<!ENTITY a "aaaa">]><D:propfind xmlns:D="DAV:"/>`)).toThrow(
      XmlError,
    );
    expect(() => parseXml(`<a><b></a></b>`)).toThrow(XmlError);
    expect(() => parseXml(`<q:a/>`)).toThrow(XmlError);
    expect(() => parseXml(`<a>`)).toThrow(XmlError);
    expect(() => parseXml(`<a/><b/>`)).toThrow(XmlError);
    expect(() => parseXml(`<a>${'x'.repeat(70_000)}</a>`)).toThrow(XmlError);
    expect(() => parseXml(`${'<a>'.repeat(40)}${'</a>'.repeat(40)}`)).toThrow(XmlError);
  });

  it('writes a multistatus with foreign properties declared, and escapes text', () => {
    const out = multistatus([
      davResponse('/Drive%20Saya/a&b.txt', [
        { status: 200, props: [{ name: '{DAV:}displayname', value: { text: '<a&b>' } }] },
        { status: 404, props: [{ name: '{http://owncloud.org/ns}checksums', value: null }] },
      ]),
    ]);
    expect(out).toContain('<D:href>/Drive%20Saya/a&amp;b.txt</D:href>');
    expect(out).toContain('<D:displayname>&lt;a&amp;b&gt;</D:displayname>');
    expect(out).toContain('<x1:checksums xmlns:x1="http://owncloud.org/ns"/>');
    expect(out).toContain('HTTP/1.1 404 Not Found');
    // What we write, we can read.
    expect(clark(parseXml(out))).toBe('{DAV:}multistatus');
  });
});

describe('WebDAV paths', () => {
  it('decodes segments and refuses climbing or broken escapes', () => {
    expect(splitDavPath('/Drive%20Saya/Foto/a%2Bb.jpg')).toEqual(['Drive Saya', 'Foto', 'a+b.jpg']);
    expect(splitDavPath('/Drive Saya//Foto/')).toEqual(['Drive Saya', 'Foto']);
    expect(splitDavPath('/')).toEqual([]);
    expect(splitDavPath('/Drive%20Saya/..')).toBeNull();
    expect(splitDavPath('/Drive%20Saya/%2E%2E/x')).toBeNull();
    expect(splitDavPath('/a%2Fb')).toBeNull();
    expect(splitDavPath('/a%00b')).toBeNull();
    expect(splitDavPath('/%E0%A4%A')).toBeNull();
  });

  it('encodes hrefs, with a slash after folders', () => {
    expect(davHref([], true)).toBe('/');
    expect(davHref(['Drive Saya', 'Foto'], true)).toBe('/Drive%20Saya/Foto/');
    expect(davHref(['Drive Saya', 'a#1?.txt'], false)).toBe('/Drive%20Saya/a%231%3F.txt');
  });

  it('knows common types by extension', () => {
    expect(mimeFromName('IMG_0001.JPG')).toBe('image/jpeg');
    expect(mimeFromName('VID.mp4')).toBe('video/mp4');
    expect(mimeFromName('x.unknown')).toBeNull();
    expect(mimeFromName('.bashrc')).toBeNull();
    expect(mimeFromName('noext')).toBeNull();
  });
});
