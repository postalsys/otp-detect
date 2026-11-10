// Renders HTML into plain text while remembering how each piece of text was styled, because the
// way a code is presented (big, bold, letter spaced, alone in its own cell) is the strongest
// signal that a number is the one-time code and not an order number.
//
// This is not a browser. It walks the tags in a single linear pass, applies the handful of inline
// styles and elements that change how text looks, and treats everything else as a container.

import type { Doc, Style } from './doc.js';
import { DEFAULT_FONT_SIZE, DEFAULT_STYLE, DocBuilder } from './doc.js';

// Comments, doctype and processing instructions, tags (quoted attribute values may contain `>`),
// text. A tag never spans a `<` outside quotes, so an unclosed tag costs a scan to the next `<`
// instead of one scan to the end of the input per `<`.
const TOKEN_RE = /<!--[\s\S]*?(?:-->|$)|<![^<>]*>|<\?[^<>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"'<]|"[^"]*"|'[^']*')*)>|[^<]+|</g;

const SKIP_CONTENT = new Set(['head', 'script', 'style', 'title', 'noscript', 'template', 'svg', 'math', 'xml']);
const VOID = new Set(['br', 'img', 'hr', 'meta', 'link', 'input', 'wbr', 'col', 'area', 'base', 'source', 'track', 'embed', 'param']);
const BLOCK = new Set([
    'p',
    'div',
    'td',
    'th',
    'tr',
    'li',
    'ul',
    'ol',
    'table',
    'tbody',
    'thead',
    'tfoot',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'section',
    'article',
    'header',
    'footer',
    'main',
    'nav',
    'aside',
    'blockquote',
    'center',
    'pre',
    'dd',
    'dt',
    'dl',
    'address',
    'form',
    'fieldset',
    'figure',
    'figcaption',
    'hr',
    'caption'
]);
const MONO_TAGS = new Set(['code', 'pre', 'tt', 'kbd', 'samp']);
const HEADING_SIZE: Record<string, number> = { h1: 32, h2: 24, h3: 19, h4: 16, h5: 13, h6: 11 };
// <font size="1"> to <font size="7"> in pixels, as browsers map them
const FONT_TAG_SIZE = [0, 10, 13, 16, 18, 24, 32, 48];

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    thinsp: ' ',
    zwnj: '',
    zwj: '',
    shy: '',
    copy: '©',
    reg: '®',
    trade: '™',
    hellip: '…',
    mdash: '-',
    ndash: '-',
    laquo: '«',
    raquo: '»',
    lsquo: "'",
    rsquo: "'",
    ldquo: '"',
    rdquo: '"',
    bdquo: '"',
    bull: '•',
    middot: '·',
    euro: '€',
    pound: '£',
    yen: '¥',
    cent: '¢',
    sect: '§',
    deg: '°',
    times: '×',
    auml: 'ä',
    ouml: 'ö',
    uuml: 'ü',
    otilde: 'õ',
    Auml: 'Ä',
    Ouml: 'Ö',
    Uuml: 'Ü',
    Otilde: 'Õ',
    scaron: 'š',
    Scaron: 'Š',
    zcaron: 'ž',
    Zcaron: 'Ž',
    szlig: 'ß',
    aacute: 'á',
    eacute: 'é',
    iacute: 'í',
    oacute: 'ó',
    uacute: 'ú',
    agrave: 'à',
    egrave: 'è',
    ecirc: 'ê',
    ccedil: 'ç',
    ntilde: 'ñ',
    aring: 'å',
    Aring: 'Å',
    oslash: 'ø',
    Oslash: 'Ø',
    aelig: 'æ',
    AElig: 'Æ'
};

const ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;

export function decodeEntities(input: string): string {
    if (!input.includes('&')) {
        return input;
    }
    return input.replace(ENTITY_RE, (match, dec?: string, hex?: string, name?: string) => {
        if (name !== undefined) {
            return NAMED_ENTITIES[name] ?? match;
        }
        const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
            return '\ufffd';
        }
        return String.fromCodePoint(code);
    });
}

// The attributes elementStyle reads, compiled once instead of on every tag
const ATTR_RE: Record<string, RegExp> = Object.fromEntries(
    ['href', 'size', 'hidden', 'style', 'class', 'type'].map(name => [name, new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')])
);

function attr(attrs: string, name: keyof typeof ATTR_RE): string | undefined {
    const m = ATTR_RE[name].exec(attrs);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : undefined;
}

function cssLength(value: string, parentSize: number): number | undefined {
    const m = /^\s*(-?[\d.]+)\s*(px|pt|em|rem|%)?/i.exec(value);
    if (!m) {
        return /^\s*0\b/.test(value) ? 0 : undefined;
    }
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) {
        return undefined;
    }
    switch ((m[2] || 'px').toLowerCase()) {
        case 'pt':
            return n * (4 / 3);
        case 'em':
            return n * parentSize;
        case 'rem':
            return n * DEFAULT_FONT_SIZE;
        case '%':
            return (n / 100) * parentSize;
        default:
            return n;
    }
}

const KEYWORD_SIZES: Record<string, number> = {
    'xx-small': 9,
    'x-small': 10,
    small: 13,
    medium: 16,
    large: 18,
    'x-large': 24,
    'xx-large': 32,
    'xxx-large': 48
};

// Applies the inline CSS declarations that change how a code would look
function applyCss(style: Style, css: string, parentSize: number): void {
    for (const decl of css.split(';')) {
        const colon = decl.indexOf(':');
        if (colon < 0) {
            continue;
        }
        const prop = decl.slice(0, colon).trim().toLowerCase();
        const value = decl
            .slice(colon + 1)
            .replace(/!important/i, '')
            .trim()
            .toLowerCase();
        applyDeclaration(style, prop, value, parentSize);
    }
}

function applyDeclaration(style: Style, prop: string, value: string, parentSize: number): void {
    switch (prop) {
        case 'font-size': {
            const size = KEYWORD_SIZES[value] ?? cssLength(value, parentSize);
            if (size !== undefined) {
                style.fontSize = size;
                style.hidden ||= size <= 1;
            }
            break;
        }
        case 'font-weight':
            style.bold = value === 'bold' || value === 'bolder' || parseInt(value, 10) >= 600;
            break;
        case 'letter-spacing': {
            const spacing = cssLength(value, parentSize);
            style.letterSpacing = spacing !== undefined && spacing >= 1;
            break;
        }
        case 'font-family':
            style.mono ||= /mono|courier|consolas|menlo/.test(value);
            break;
        case 'display':
            style.hidden ||= value === 'none';
            break;
        case 'visibility':
            style.hidden ||= value === 'hidden';
            break;
        case 'opacity':
            style.hidden ||= parseFloat(value) === 0;
            break;
        case 'max-height':
        case 'height':
            style.hidden ||= /^0(?:px)?$/.test(value);
            break;
        default:
            break;
    }
}

function elementStyle(tag: string, attrs: string, parent: Style): Style {
    const style: Style = { ...parent };
    if (tag === 'b' || tag === 'strong') {
        style.bold = true;
    } else if (tag in HEADING_SIZE) {
        style.heading = true;
        style.bold = true;
        style.fontSize = HEADING_SIZE[tag];
    } else if (tag === 'a' && attr(attrs, 'href')) {
        style.link = true;
    } else if (tag === 'blockquote') {
        style.quote = true;
    } else if (MONO_TAGS.has(tag)) {
        style.mono = true;
    } else if (tag === 'font') {
        const size = parseInt(attr(attrs, 'size') ?? '', 10);
        if (size >= 1 && size <= 7) {
            style.fontSize = FONT_TAG_SIZE[size];
        }
    }
    if (attr(attrs, 'hidden') !== undefined) {
        style.hidden = true;
    }
    const css = attr(attrs, 'style');
    if (css) {
        applyCss(style, css, parent.fontSize);
    }
    // Quoted reply history in the common clients
    const cls = attr(attrs, 'class') ?? '';
    if (/\bgmail_quote\b|\byahoo_quoted\b|\bmoz-cite-prefix\b/i.test(cls) || attr(attrs, 'type')?.toLowerCase() === 'cite') {
        style.quote = true;
    }
    return style;
}

type Open = { tag: string; style: Style; block: boolean };

export function renderHtml(html: string): Doc {
    const doc = new DocBuilder('html');
    const stack: Open[] = [];
    let skipUntil: string | null = null;
    const current = (): Style => (stack.length ? stack[stack.length - 1].style : DEFAULT_STYLE);

    TOKEN_RE.lastIndex = 0;
    for (let m = TOKEN_RE.exec(html); m; m = TOKEN_RE.exec(html)) {
        const token = m[0];
        const tag = m[2]?.toLowerCase();
        if (skipUntil) {
            if (tag === skipUntil && m[1] === '/') {
                skipUntil = null;
            }
            continue;
        }
        if (tag === undefined) {
            if (token[0] !== '<' || token === '<') {
                doc.text(decodeEntities(token), current());
            }
            continue;
        }
        if (m[1] === '/') {
            closeTag(doc, stack, tag);
            continue;
        }
        const attrs = m[3] ?? '';
        const selfClosing = /\/\s*$/.test(attrs);
        if (SKIP_CONTENT.has(tag) && !selfClosing) {
            skipUntil = tag;
            continue;
        }
        openTag(doc, stack, tag, attrs, selfClosing, current());
    }
    return doc.finish();
}

function openTag(doc: DocBuilder, stack: Open[], tag: string, attrs: string, selfClosing: boolean, parent: Style): void {
    if (tag === 'br') {
        doc.newline();
        return;
    }
    const block = BLOCK.has(tag);
    if (VOID.has(tag) || selfClosing) {
        if (block) {
            doc.newline();
        }
        return;
    }
    if (block) {
        doc.openBlock();
    }
    stack.push({ tag, style: elementStyle(tag, attrs, parent), block });
}

function closeTag(doc: DocBuilder, stack: Open[], tag: string): void {
    // Close up to the matching element; a stray close tag with no match is ignored
    let i = stack.length - 1;
    while (i >= 0 && stack[i].tag !== tag) {
        i--;
    }
    if (i < 0) {
        return;
    }
    while (stack.length > i) {
        const open = stack.pop() as Open;
        if (open.block) {
            doc.closeBlock();
        }
    }
}
