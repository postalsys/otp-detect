// Finds every token in a document that could be a one-time code. This step is deliberately
// generous: a code it misses can never be found, while a wrong candidate only costs the scorer
// one more row to reject.

import type { Doc } from './doc.js';

export type CandidateKind = 'token' | 'dashed-part' | 'grouped' | 'spaced';

export type Candidate = {
    /** The code as it would be typed: separators inside digit groups and spaced letters removed */
    code: string;
    /** The text as it appears in the document */
    raw: string;
    start: number;
    end: number;
    kind: CandidateKind;
};

const TOKEN_RE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/g;
// Single characters separated by single spaces or line breaks: "4 8 2 9 1 7", or one digit per table cell
const SPACED_RE = /(?<![A-Za-z0-9])[A-Z0-9](?:[ \n][A-Z0-9]){3,9}(?![A-Za-z0-9])/g;
// Characters that glue a token to its neighbour into something that is not a code: 12.50, 10:30,
// 1,000, a/b, user@host, snake_case
const JOINERS = new Set(['.', ',', ':', '/', '@', '_', '\\', '=', '&', '?', '%', '+']);
const ALNUM_RE = /[A-Za-z0-9]/;

const MAX_CANDIDATES = 400;

type Token = { start: number; end: number; value: string };

function isAlnum(ch: string | undefined): boolean {
    return ch !== undefined && ALNUM_RE.test(ch);
}

/** Whether a token without separators looks like a code */
export function codeLike(core: string): boolean {
    const len = core.length;
    if (len > 12 && len <= 40) {
        // Long random validation codes mix upper case, lower case and digits (domain validation)
        return /[A-Z]/.test(core) && /[a-z]/.test(core) && /\d/.test(core) && /^[A-Za-z0-9]+$/.test(core);
    }
    if (len < 4 || len > 12) {
        return false;
    }
    if (/^\d+$/.test(core)) {
        return len <= 10;
    }
    const hasDigit = /\d/.test(core);
    if (!hasDigit) {
        // Letter-only codes are printed in capitals (Steam Guard style: QWKZT)
        return /^[A-Z]+$/.test(core) && len <= 10;
    }
    if (!/[A-Za-z]/.test(core)) {
        return false;
    }
    // 21st, 100mg, 1080p, 12px, 5000mAh
    return !/^\d+(?:[a-z]{1,3}|mAh|MB|GB|KB|kB|Hz)$/.test(core);
}

// Checked once per whitespace separated chunk, never per token, so a long blob stays linear
const URL_OR_ADDRESS_RE = /:\/\/|^www\.|@[A-Za-z0-9-]+\.|\.[a-z]{2,6}\//i;
const CHUNK_RE = /\S+/g;

function gluedToNeighbour(text: string, start: number, end: number): boolean {
    const before = text[start - 1];
    const after = text[end];
    if (before !== undefined && JOINERS.has(before) && isAlnum(text[start - 2])) {
        return true;
    }
    return after !== undefined && JOINERS.has(after) && isAlnum(text[end + 1]);
}

function make(text: string, start: number, end: number, kind: CandidateKind, code: string): Candidate {
    return { code, raw: text.slice(start, end), start, end, kind };
}

function tokenCandidates(text: string, out: Candidate[]): void {
    const tokens: Token[] = [];
    CHUNK_RE.lastIndex = 0;
    for (let chunk = CHUNK_RE.exec(text); chunk; chunk = CHUNK_RE.exec(text)) {
        if (URL_OR_ADDRESS_RE.test(chunk[0])) {
            continue;
        }
        TOKEN_RE.lastIndex = 0;
        for (let m = TOKEN_RE.exec(chunk[0]); m; m = TOKEN_RE.exec(chunk[0])) {
            const start = chunk.index + m.index;
            const end = start + m[0].length;
            if (!gluedToNeighbour(text, start, end)) {
                tokens.push({ start, end, value: m[0] });
                addToken(text, start, m[0], out);
            }
        }
    }
    addDigitGroups(text, tokens, out);
}

function addToken(text: string, start: number, value: string, out: Candidate[]): void {
    const end = start + value.length;
    if (!value.includes('-')) {
        if (codeLike(value)) {
            out.push(make(text, start, end, 'token', value));
        }
        return;
    }
    const parts = value.split('-');
    const joined = parts.join('');
    if (/^\d+$/.test(joined)) {
        // 123-456, 12-34-56: typed without the dashes. Other digit runs are phone numbers and dates
        if (parts.every(p => p.length >= 2 && p.length <= 4) && codeLike(joined)) {
            out.push(make(text, start, end, 'grouped', joined));
        }
        return;
    }
    if (joined.length >= 4 && value.length <= 40 && /\d/.test(joined) && /[A-Za-z]/.test(joined)) {
        // ABCD-1234, G-123456, 4a7c01e9-82f3b6d0: keys printed with their dashes. Digit-only runs
        // that are not two to four even groups are phone numbers and dates (372-5-555-0100)
        out.push(make(text, start, end, 'token', value));
    }
    let offset = start;
    for (const part of parts) {
        if (codeLike(part)) {
            out.push(make(text, offset, offset + part.length, 'dashed-part', part));
        }
        offset += part.length + 1;
    }
}

// "123 456" and "1234 5678": two or three digit groups separated by a single space
function addDigitGroups(text: string, tokens: Token[], out: Candidate[]): void {
    for (let i = 0; i < tokens.length; i++) {
        let digits = '';
        for (let j = i; j < tokens.length && j < i + 3; j++) {
            const token = tokens[j];
            const separatedBySpace = j === i || (token.start === tokens[j - 1].end + 1 && text[token.start - 1] === ' ');
            if (!/^\d{2,4}$/.test(token.value) || !separatedBySpace) {
                break;
            }
            digits += token.value;
            if (j > i && digits.length >= 6 && digits.length <= 9) {
                out.push(make(text, tokens[i].start, token.end, 'grouped', digits));
            }
        }
    }
}

function spacedCandidates(text: string, out: Candidate[]): void {
    SPACED_RE.lastIndex = 0;
    for (let m = SPACED_RE.exec(text); m; m = SPACED_RE.exec(text)) {
        const code = m[0].replace(/[ \n]/g, '');
        if (/\d/.test(code)) {
            out.push(make(text, m.index, m.index + m[0].length, 'spaced', code));
        }
    }
}

export function extractCandidates(doc: Doc): Candidate[] {
    const out: Candidate[] = [];
    tokenCandidates(doc.text, out);
    spacedCandidates(doc.text, out);
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    return out.slice(0, MAX_CANDIDATES);
}
