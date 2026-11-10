// Turns each candidate into a fixed-length vector of numbers for the scorer. FEATURE_NAMES is the
// contract with the trained model: training records the names it was fit on, and the model refuses
// to load against a different list. Add features at the end and retrain; never reorder.

import type { Candidate } from './candidates.js';
import { blockAround, styleAt } from './doc.js';
import type { Doc } from './doc.js';
import { CUE, findAll, matches, NEGATIVE, PROMO, STRONG, WEAK } from './keywords.js';

export const FEATURE_NAMES = [
    // shape
    'len',
    'digits',
    'upper',
    'lower',
    'isDigits',
    'isUpperAlpha',
    'isMixedCase',
    'kindGrouped',
    'kindSpaced',
    'kindDashedPart',
    'hasDash',
    'leadingZero',
    'distinctRatio',
    'trivialSequence',
    'looksYear',
    // characters around it
    'colonBefore',
    'hashBefore',
    'currencyNear',
    'plusOrParenBefore',
    'digitNearby',
    'percentAfter',
    // keywords, distances in characters, capped
    'strongBefore',
    'strongAfter',
    'weakBefore',
    'weakAfter',
    'cueBefore',
    'cueAfter',
    'negBefore',
    'negAfter',
    'strongInLine',
    'weakInLine',
    'negInLine',
    'strongRank',
    // layout and style
    'lineLen',
    'aloneOnLine',
    'blockLen',
    'aloneInBlock',
    'fontSize',
    'fontRatio',
    'isLargestFont',
    'bold',
    'letterSpacing',
    'link',
    'heading',
    'mono',
    'hidden',
    'quoted',
    'relPosition',
    'fromHtml',
    // message
    'occurrences',
    'inOtherDoc',
    'inSubject',
    'subjectStrong',
    'subjectWeak',
    'subjectNeg',
    'docStrong',
    'docCue',
    'docLen',
    'candidates',
    'distinctCodes',
    'candidateIndex',
    // codes that prove nothing: promotions, referrals, invitations
    'promoBefore',
    'promoAfter',
    'promoInLine',
    'docPromo',
    'subjectPromo',
    // letters-only codes are random (QWKZT), words in capitals are not (WEBINAR)
    'vowelRatio',
    // identifiers from code and prose (loginFailedError, retry2fa) have word-like letter runs
    'longestLetterRun',
    'caseChanges'
] as const;

const FAR = 1000;
const CURRENCY_RE = /[€$£¥₽]|\b(?:eur|usd|gbp|sek|nok|dkk|rub)\b/i;

type Hits = { start: number; end: number }[];

/** Per-document data shared by all candidates of the document */
export type DocContext = {
    doc: Doc;
    strong: Hits;
    weak: Hits;
    cue: Hits;
    neg: Hits;
    promo: Hits;
    dominantFont: number;
    maxCandidateFont: number;
    candidates: Candidate[];
    strongRanks: Map<Candidate, number>;
    /** How many candidates of the document share each code */
    codeCounts: Map<string, number>;
};

/** Message data shared by the documents of one email */
export type MessageContext = {
    subject: string;
    otherText: string;
    distinctCodes: number;
    subjectStrong: boolean;
    subjectWeak: boolean;
    subjectNeg: boolean;
    subjectPromo: boolean;
};

export function messageContext(subject: string, otherText: string, distinctCodes: number): MessageContext {
    return {
        subject,
        otherText,
        distinctCodes,
        subjectStrong: matches(STRONG, subject),
        subjectWeak: matches(WEAK, subject),
        subjectNeg: matches(NEGATIVE, subject),
        subjectPromo: matches(PROMO, subject)
    };
}

// Hits come from one global regex, so they are sorted and do not overlap: starts and ends both
// increase, and every lookup below is a binary search instead of a scan of an uncapped list.

/** Index of the first hit whose `key` is at least `pos`, hits.length if none */
function firstAtLeast(hits: Hits, key: 'start' | 'end', pos: number): number {
    let lo = 0;
    let hi = hits.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (hits[mid][key] < pos) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/** Distance from the end of the closest hit that ends at or before pos */
function distanceBefore(hits: Hits, pos: number): number {
    const i = firstAtLeast(hits, 'end', pos + 1) - 1;
    return i >= 0 ? Math.min(FAR, pos - hits[i].end) : FAR;
}

/** Distance to the start of the first hit that starts at or after pos */
function distanceAfter(hits: Hits, pos: number): number {
    const i = firstAtLeast(hits, 'start', pos);
    return i < hits.length ? Math.min(FAR, hits[i].start - pos) : FAR;
}

/** Whether a whole hit lies within [from, to]; the first hit starting at from has the smallest end */
function inRange(hits: Hits, from: number, to: number): boolean {
    const i = firstAtLeast(hits, 'start', from);
    return i < hits.length && hits[i].end <= to;
}

function dominantFontSize(doc: Doc): number {
    const chars = new Map<number, number>();
    for (const span of doc.spans) {
        if (!span.style.hidden) {
            const size = Math.round(span.style.fontSize);
            chars.set(size, (chars.get(size) ?? 0) + span.end - span.start);
        }
    }
    let best = 16;
    let most = 0;
    for (const [size, count] of chars) {
        if (count > most) {
            best = size;
            most = count;
        }
    }
    return best;
}

function rankByStrongDistance(strong: Hits, candidates: Candidate[]): Map<Candidate, number> {
    // Keys computed once; the sort is stable, so equal distances keep document order
    const keyed = candidates.map(c => ({ c, key: Math.min(distanceBefore(strong, c.start), distanceAfter(strong, c.end)) }));
    keyed.sort((a, b) => a.key - b.key);
    return new Map(keyed.map((k, i) => [k.c, i]));
}

export function docContext(doc: Doc, candidates: Candidate[]): DocContext {
    const strong = findAll(STRONG, doc.text);
    const codeCounts = new Map<string, number>();
    for (const c of candidates) {
        codeCounts.set(c.code, (codeCounts.get(c.code) ?? 0) + 1);
    }
    return {
        doc,
        strong,
        weak: findAll(WEAK, doc.text),
        cue: findAll(CUE, doc.text),
        neg: findAll(NEGATIVE, doc.text),
        promo: findAll(PROMO, doc.text),
        dominantFont: dominantFontSize(doc),
        maxCandidateFont: Math.max(0, ...candidates.map(c => styleAt(doc, c.start).fontSize)),
        candidates,
        strongRanks: rankByStrongDistance(strong, candidates),
        codeCounts
    };
}

type Line = { start: number; end: number; text: string };

function lineOf(text: string, c: Candidate): Line {
    const start = text.lastIndexOf('\n', c.start - 1) + 1;
    const nl = text.indexOf('\n', c.end);
    const end = nl < 0 ? text.length : nl;
    return { start, end, text: text.slice(start, end) };
}

function shapeFeatures(c: Candidate): number[] {
    const code = c.code;
    const digits = (code.match(/\d/g) ?? []).length;
    const upper = (code.match(/[A-Z]/g) ?? []).length;
    const lower = (code.match(/[a-z]/g) ?? []).length;
    const trivial = /^(\d)\1+$/.test(code) || '0123456789'.includes(code) || '9876543210'.includes(code);
    return [
        code.length,
        digits,
        upper,
        lower,
        Number(digits === code.length),
        Number(upper === code.length),
        Number(upper > 0 && lower > 0),
        Number(c.kind === 'grouped'),
        Number(c.kind === 'spaced'),
        Number(c.kind === 'dashed-part'),
        Number(c.raw.includes('-')),
        Number(code.startsWith('0')),
        new Set(code).size / code.length,
        Number(trivial),
        Number(/^(?:19|20)\d\d$/.test(code))
    ];
}

function surroundingFeatures(text: string, c: Candidate): number[] {
    const before = text.slice(Math.max(0, c.start - 4), c.start);
    const after = text.slice(c.end, c.end + 4);
    return [
        Number(/:\s*$/.test(before)),
        Number(/#\s*$/.test(before)),
        Number(CURRENCY_RE.test(before) || CURRENCY_RE.test(after)),
        Number(/[+(]\s*$/.test(before)),
        Number(/\d/.test(text.slice(Math.max(0, c.start - 3), c.start)) || /\d/.test(text.slice(c.end, c.end + 3))),
        Number(/^\s*%/.test(after))
    ];
}

function keywordFeatures(ctx: DocContext, c: Candidate, line: Line): number[] {
    return [
        distanceBefore(ctx.strong, c.start),
        distanceAfter(ctx.strong, c.end),
        distanceBefore(ctx.weak, c.start),
        distanceAfter(ctx.weak, c.end),
        distanceBefore(ctx.cue, c.start),
        distanceAfter(ctx.cue, c.end),
        distanceBefore(ctx.neg, c.start),
        distanceAfter(ctx.neg, c.end),
        Number(inRange(ctx.strong, line.start, line.end)),
        Number(inRange(ctx.weak, line.start, line.end)),
        Number(inRange(ctx.neg, line.start, line.end)),
        ctx.strongRanks.get(c) as number
    ];
}

function layoutFeatures(ctx: DocContext, c: Candidate, line: Line): number[] {
    const { doc } = ctx;
    const style = styleAt(doc, c.start);
    const block = blockAround(doc, c.start, c.end);
    const blockText = doc.text.slice(block.start, block.end).trim();
    const lineText = line.text.trim();
    return [
        lineText.length,
        Number(lineText === c.raw),
        blockText.length,
        Number(blockText === c.raw),
        style.fontSize,
        style.fontSize / (ctx.dominantFont || 16),
        Number(style.fontSize >= ctx.maxCandidateFont),
        Number(style.bold),
        Number(style.letterSpacing),
        Number(style.link),
        Number(style.heading),
        Number(style.mono),
        Number(style.hidden),
        Number(style.quote || c.start >= doc.quoteStart),
        doc.text.length ? c.start / doc.text.length : 0,
        Number(doc.source === 'html')
    ];
}

function vowelRatio(code: string): number {
    const letters = code.match(/[A-Za-z]/g) ?? [];
    if (!letters.length) {
        return -1;
    }
    return letters.filter(ch => /[aeiouy]/i.test(ch)).length / letters.length;
}

function promoFeatures(ctx: DocContext, msg: MessageContext, c: Candidate, line: Line): number[] {
    return [
        distanceBefore(ctx.promo, c.start),
        distanceAfter(ctx.promo, c.end),
        Number(inRange(ctx.promo, line.start, line.end)),
        ctx.promo.length,
        Number(msg.subjectPromo)
    ];
}

function messageFeatures(ctx: DocContext, msg: MessageContext, c: Candidate, index: number): number[] {
    return [
        ctx.codeCounts.get(c.code) as number,
        Number(msg.otherText.includes(c.raw) || msg.otherText.includes(c.code)),
        Number(msg.subject.includes(c.raw) || msg.subject.includes(c.code)),
        Number(msg.subjectStrong),
        Number(msg.subjectWeak),
        Number(msg.subjectNeg),
        ctx.strong.length,
        Number(ctx.cue.length > 0),
        Math.log1p(ctx.doc.text.length),
        ctx.candidates.length,
        msg.distinctCodes,
        index
    ];
}

function codeTextFeatures(code: string): number[] {
    return [
        vowelRatio(code),
        Math.max(0, ...(code.match(/[A-Za-z]+/g) ?? []).map(run => run.length)),
        (code.match(/[a-z](?=[A-Z])|[A-Z](?=[a-z])/g) ?? []).length
    ];
}

/** The feature vector of the candidate at `index` in ctx.candidates */
export function candidateFeatures(ctx: DocContext, msg: MessageContext, index: number): number[] {
    const c = ctx.candidates[index];
    const text = ctx.doc.text;
    const line = lineOf(text, c);
    const row = [
        ...shapeFeatures(c),
        ...surroundingFeatures(text, c),
        ...keywordFeatures(ctx, c, line),
        ...layoutFeatures(ctx, c, line),
        ...messageFeatures(ctx, msg, c, index),
        ...promoFeatures(ctx, msg, c, line),
        ...codeTextFeatures(c.code)
    ];
    if (row.length !== FEATURE_NAMES.length) {
        throw new Error(`feature vector has ${row.length} values, expected ${FEATURE_NAMES.length}`);
    }
    return row;
}
