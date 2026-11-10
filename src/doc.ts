// The common representation both the HTML and the plain text body are turned into: visible text,
// the style of every stretch of it, and the blocks (paragraphs, table cells, lines) it is split in.

export const DEFAULT_FONT_SIZE = 16;

export type Style = {
    fontSize: number;
    bold: boolean;
    letterSpacing: boolean;
    link: boolean;
    heading: boolean;
    mono: boolean;
    hidden: boolean;
    /** Inside quoted reply history or a forwarded message */
    quote: boolean;
};

export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({
    fontSize: DEFAULT_FONT_SIZE,
    bold: false,
    letterSpacing: false,
    link: false,
    heading: false,
    mono: false,
    hidden: false,
    quote: false
});

export type Span = { start: number; end: number };
export type StyledSpan = Span & { style: Readonly<Style> };

export type Doc = {
    source: 'html' | 'text';
    text: string;
    /** Consecutive, non-overlapping, sorted by start; text between spans is whitespace */
    spans: StyledSpan[];
    /** Every block, innermost ones included, sorted by start */
    blocks: Span[];
    /** Offset where reply history or a forwarded message starts, text.length if none */
    quoteStart: number;
};

const SPACE_RE = /[\s\u00a0\u200b\u200c\u200d\u2028\u2029\ufeff]+/g;

// "On Tue, 1 Jan 2025 John wrote:", Outlook and forward separators, and the same in Estonian
const ATTRIBUTION_RE =
    /^(?:-{2,}\s*(?:original message|forwarded message|edastatud kiri|algne kiri)\s*-{2,}|-{5,}|on .{3,200}(?:wrote|kirjutas):|.{3,120}kirjutas(?: .{0,80})?:|from: .{3,200}\n(?:sent|date): )/im;

export class DocBuilder {
    // The output is kept as parts plus its length and last character: reading back a string that
    // is being appended to makes V8 flatten it on every call, which is quadratic on large bodies
    private parts: string[] = [];
    private length = 0;
    private last = '';
    private spans: StyledSpan[] = [];
    private blocks: Span[] = [];
    private openBlocks: number[] = [];

    private readonly source: 'html' | 'text';

    constructor(source: 'html' | 'text') {
        this.source = source;
    }

    private append(chunk: string): void {
        this.parts.push(chunk);
        this.length += chunk.length;
        this.last = chunk[chunk.length - 1];
    }

    text(raw: string, style: Readonly<Style>): void {
        const collapsed = raw.replace(SPACE_RE, ' ');
        const atLineStart = this.length === 0 || this.last === '\n' || this.last === ' ';
        const chunk = atLineStart && collapsed.startsWith(' ') ? collapsed.slice(1) : collapsed;
        if (!chunk) {
            return;
        }
        const start = this.length;
        this.append(chunk);
        const span = this.spans[this.spans.length - 1];
        if (span && span.style === style && span.end === start) {
            span.end = this.length;
        } else {
            this.spans.push({ start, end: this.length, style });
        }
    }

    private dropTrailingSpace(): void {
        if (this.last !== ' ') {
            return;
        }
        const part = this.parts.pop() as string;
        const rest = part.slice(0, -1);
        this.length--;
        if (rest) {
            this.parts.push(rest);
        }
        const prev = this.parts[this.parts.length - 1];
        this.last = prev ? prev[prev.length - 1] : '';
        const span = this.spans[this.spans.length - 1];
        if (span && span.end > this.length) {
            span.end = this.length;
        }
    }

    newline(): void {
        this.dropTrailingSpace();
        if (this.length && this.last !== '\n') {
            this.append('\n');
        }
    }

    openBlock(): void {
        this.newline();
        this.openBlocks.push(this.length);
    }

    closeBlock(): void {
        const start = this.openBlocks.pop();
        if (start === undefined) {
            return;
        }
        // Text is collapsed as it is added, so at most one whitespace character trails it
        const end = this.length - (this.last === '\n' || this.last === ' ' ? 1 : 0);
        if (end > start) {
            this.blocks.push({ start, end });
        }
        this.newline();
    }

    finish(): Doc {
        while (this.openBlocks.length) {
            this.closeBlock();
        }
        const text = this.parts.join('').replace(/\s+$/, '');
        const spans = this.spans.filter(s => s.start < text.length).map(s => ({ ...s, end: Math.min(s.end, text.length) }));
        // Every line is a block too, which covers plain text and HTML without block elements
        for (const line of text.matchAll(/[^\n]+/g)) {
            this.blocks.push({ start: line.index, end: line.index + line[0].length });
        }
        this.blocks.sort((a, b) => a.start - b.start || b.end - a.end);
        const attribution = ATTRIBUTION_RE.exec(text);
        return { source: this.source, text, spans, blocks: this.blocks, quoteStart: attribution ? attribution.index : text.length };
    }
}

const QUOTED_STYLE: Readonly<Style> = Object.freeze({ ...DEFAULT_STYLE, quote: true });

export function renderText(input: string): Doc {
    const doc = new DocBuilder('text');
    for (const line of input.replace(/\r\n?/g, '\n').split('\n')) {
        doc.text(line, /^\s*>/.test(line) ? QUOTED_STYLE : DEFAULT_STYLE);
        doc.newline();
    }
    return doc.finish();
}

/** The style at a text offset; whitespace between spans takes the style of the span before it */
export function styleAt(doc: Doc, offset: number): Readonly<Style> {
    let lo = 0;
    let hi = doc.spans.length - 1;
    let found: StyledSpan | undefined;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const span = doc.spans[mid];
        if (span.start <= offset) {
            found = span;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found?.style ?? DEFAULT_STYLE;
}

/** The smallest block that contains the whole range */
export function blockAround(doc: Doc, start: number, end: number): Span {
    let best: Span = { start: 0, end: doc.text.length };
    for (const block of doc.blocks) {
        if (block.start > start) {
            break;
        }
        if (block.end >= end && block.end - block.start < best.end - best.start) {
            best = block;
        }
    }
    return best;
}
