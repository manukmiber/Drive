// The XML WebDAV needs (D9, ADR-089). Request bodies (PROPFIND, PROPPATCH, LOCK) are small but use
// namespaces freely (`D:`, `d:`, `a:` or a default namespace), so they are read by a little
// namespace-aware parser rather than by tag text; responses are built as strings with the DAV:
// namespace as `D:`. Workers have no DOMParser.
import { esc } from './s3-xml';

export const DAV_NS = 'DAV:';

export interface XmlNode {
  ns: string;
  local: string;
  children: XmlNode[];
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/** Request bodies past this are refused before parsing. */
export const DAV_XML_MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 2000;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

interface Open {
  node: XmlNode;
  scope: Map<string, string>;
}

/**
 * Parses an XML document into elements with resolved namespaces. DOCTYPE is refused (no entity
 * expansion), and size, depth and element count are bounded.
 */
export function parseXml(xml: string): XmlNode {
  if (xml.length > DAV_XML_MAX_BYTES) throw new XmlError('body too large');
  let i = 0;
  let count = 0;
  let root: XmlNode | null = null;
  const stack: Open[] = [];
  const rootScope = new Map<string, string>([['xml', 'http://www.w3.org/XML/1998/namespace']]);

  const scopeNow = () => stack[stack.length - 1]?.scope ?? rootScope;

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt === -1 ? xml.length : lt);
    if (text) {
      const top = stack[stack.length - 1];
      if (top) top.node.text += decode(text);
      else if (text.trim()) throw new XmlError('text outside the root element');
    }
    if (lt === -1) break;
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unclosed processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('unclosed comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('unclosed CDATA');
      const top = stack[stack.length - 1];
      if (!top) throw new XmlError('CDATA outside the root element');
      top.node.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new XmlError('DOCTYPE is not allowed');
    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) throw new XmlError('unclosed tag');
    const raw = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top) throw new XmlError(`unexpected </${name}>`);
      const { prefix, local } = splitName(name);
      const ns = resolve(top.scope, prefix, true);
      if (local !== top.node.local || ns !== top.node.ns)
        throw new XmlError(`</${name}> does not close <${top.node.local}>`);
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new XmlError('bad tag');
    const tagName = m[1]!;
    const attrs = parseAttributes(body.slice(tagName.length));
    const scope = new Map(scopeNow());
    for (const [k, v] of attrs) {
      if (k === 'xmlns') scope.set('', v);
      else if (k.startsWith('xmlns:')) scope.set(k.slice(6), v);
    }
    const { prefix, local } = splitName(tagName);
    const node: XmlNode = { ns: resolve(scope, prefix, true), local, children: [], text: '' };
    if (++count > MAX_NODES) throw new XmlError('too many elements');
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else if (root) throw new XmlError('more than one root element');
    else root = node;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) throw new XmlError('too deep');
      stack.push({ node, scope });
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1]!.node.local}> is not closed`);
  if (!root) throw new XmlError('no root element');
  return root;
}

/** The `>` that ends a tag, skipping quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let j = from; j < xml.length; j++) {
    const ch = xml[j]!;
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return j;
  }
  return -1;
}

function parseAttributes(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.set(m[1]!, decode(m[3] ?? m[4] ?? ''));
  return out;
}

function splitName(name: string): { prefix: string; local: string } {
  const c = name.indexOf(':');
  return c === -1
    ? { prefix: '', local: name }
    : { prefix: name.slice(0, c), local: name.slice(c + 1) };
}

function resolve(scope: Map<string, string>, prefix: string, element: boolean): string {
  const ns = scope.get(prefix);
  if (ns !== undefined) return ns;
  if (!prefix && element) return '';
  throw new XmlError(`unknown namespace prefix ${prefix}`);
}

export const isDav = (n: XmlNode, local: string) => n.ns === DAV_NS && n.local === local;

export function child(n: XmlNode, local: string, ns = DAV_NS): XmlNode | undefined {
  return n.children.find((c) => c.ns === ns && c.local === local);
}

/** A property name as `{namespace}local` (Clark notation), the key properties are matched by. */
export const clark = (n: Pick<XmlNode, 'ns' | 'local'>) => `{${n.ns}}${n.local}`;

// ───────────────────────────── responses ─────────────────────────────

/** A property value to write: text, raw XML (already escaped), or empty. */
export type PropValue = { text: string } | { xml: string } | null;

export interface PropStat {
  status: number;
  props: Array<{ name: string; value: PropValue }>;
}

const REASONS: Record<number, string> = {
  200: 'OK',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  424: 'Failed Dependency',
};

/** Writes a Clark-named property as an element, with its namespace declared when not DAV:. */
function propElement(name: string, value: PropValue, prefixes: Map<string, string>): string {
  const m = /^\{([^}]*)\}(.+)$/.exec(name);
  const ns = m ? m[1]! : DAV_NS;
  const local = m ? m[2]! : name;
  const safeLocal = /^[A-Za-z_][\w.-]*$/.test(local) ? local : 'unknown';
  let tag: string;
  let decl = '';
  if (ns === DAV_NS) tag = `D:${safeLocal}`;
  else if (!ns) tag = safeLocal;
  else {
    let p = prefixes.get(ns);
    if (!p) prefixes.set(ns, (p = `x${prefixes.size + 1}`));
    tag = `${p}:${safeLocal}`;
    decl = ` xmlns:${p}="${esc(ns)}"`;
  }
  if (value === null) return `<${tag}${decl}/>`;
  const inner = 'xml' in value ? value.xml : esc(value.text);
  return `<${tag}${decl}>${inner}</${tag}>`;
}

/** One `<D:response>`: the href and its propstats. */
export function davResponse(href: string, stats: PropStat[]): string {
  const prefixes = new Map<string, string>();
  const body = stats
    .filter((s) => s.props.length)
    .map(
      (s) =>
        `<D:propstat><D:prop>${s.props.map((p) => propElement(p.name, p.value, prefixes)).join('')}</D:prop>` +
        `<D:status>HTTP/1.1 ${s.status} ${REASONS[s.status] ?? ''}</D:status></D:propstat>`,
    )
    .join('');
  return `<D:response><D:href>${esc(href)}</D:href>${body}</D:response>`;
}

/** A `<D:response>` that carries only a status (errors in a multistatus). */
export function davStatusResponse(href: string, status: number): string {
  return `<D:response><D:href>${esc(href)}</D:href><D:status>HTTP/1.1 ${status} ${REASONS[status] ?? ''}</D:status></D:response>`;
}

export function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

/** `<D:error>` with one precondition element (RFC 4918 §16). */
export function davError(condition: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:${condition}/></D:error>`;
}
