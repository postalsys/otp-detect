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

export type FeatureName = (typeof FEATURE_NAMES)[number];

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
};

/** Message data shared by the documents of one email */
export type MessageContext = {
    subject: string;
    otherText: string;
    distinctCodes: number;
};

function distanceBefore(hits: Hits, pos: number): number {
    let best = FAR;
    for (const h of hits) {
        if (h.end > pos) {
            break;
        }
        best = Math.min(best, pos - h.end);
    }
    return best;
}

function distanceAfter(hits: Hits, pos: number): number {
    for (const h of hits) {
        if (h.start >= pos) {
            return Math.min(FAR, h.start - pos);
        }
    }
    return FAR;
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

export function docContext(doc: Doc, candidates: Candidate[]): DocContext {
    const strong = findAll(STRONG, doc.text);
    const ctx: DocContext = {
        doc,
        strong,
        weak: findAll(WEAK, doc.text),
        cue: findAll(CUE, doc.text),
        neg: findAll(NEGATIVE, doc.text),
        promo: findAll(PROMO, doc.text),
        dominantFont: dominantFontSize(doc),
        maxCandidateFont: Math.max(0, ...candidates.map(c => styleAt(doc, c.start).fontSize)),
        candidates,
        strongRanks: new Map()
    };
    const nearest = (c: Candidate) => Math.min(distanceBefore(strong, c.start), distanceAfter(strong, c.end));
    const sorted = [...candidates].sort((a, b) => nearest(a) - nearest(b));
    sorted.forEach((c, i) => ctx.strongRanks.set(c, i));
    return ctx;
}

function lineAround(text: string, start: number, end: number): string {
    const a = text.lastIndexOf('\n', start - 1) + 1;
    const b = text.indexOf('\n', end);
    return text.slice(a, b < 0 ? text.length : b);
}

function inRange(hits: Hits, from: number, to: number): boolean {
    return hits.some(h => h.start >= from && h.end <= to);
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

function keywordFeatures(ctx: DocContext, c: Candidate, line: string, lineStart: number): number[] {
    const lineEnd = lineStart + line.length;
    return [
        distanceBefore(ctx.strong, c.start),
        distanceAfter(ctx.strong, c.end),
        distanceBefore(ctx.weak, c.start),
        distanceAfter(ctx.weak, c.end),
        distanceBefore(ctx.cue, c.start),
        distanceAfter(ctx.cue, c.end),
        distanceBefore(ctx.neg, c.start),
        distanceAfter(ctx.neg, c.end),
        Number(inRange(ctx.strong, lineStart, lineEnd)),
        Number(inRange(ctx.weak, lineStart, lineEnd)),
        Number(inRange(ctx.neg, lineStart, lineEnd)),
        ctx.strongRanks.get(c) ?? ctx.candidates.length
    ];
}

function layoutFeatures(ctx: DocContext, c: Candidate, line: string): number[] {
    const { doc } = ctx;
    const style = styleAt(doc, c.start);
    const block = blockAround(doc, c.start, c.end);
    const blockText = doc.text.slice(block.start, block.end).trim();
    return [
        line.trim().length,
        Number(line.trim() === c.raw),
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

function promoFeatures(ctx: DocContext, msg: MessageContext, c: Candidate, line: string, lineStart: number): number[] {
    return [
        distanceBefore(ctx.promo, c.start),
        distanceAfter(ctx.promo, c.end),
        Number(inRange(ctx.promo, lineStart, lineStart + line.length)),
        ctx.promo.length,
        Number(matches(PROMO, msg.subject))
    ];
}

function messageFeatures(ctx: DocContext, msg: MessageContext, c: Candidate): number[] {
    const occurrences = ctx.candidates.filter(o => o.code === c.code).length;
    return [
        occurrences,
        Number(msg.otherText.includes(c.raw) || msg.otherText.includes(c.code)),
        Number(msg.subject.includes(c.raw) || msg.subject.includes(c.code)),
        Number(matches(STRONG, msg.subject)),
        Number(matches(WEAK, msg.subject)),
        Number(matches(NEGATIVE, msg.subject)),
        ctx.strong.length,
        Number(ctx.cue.length > 0),
        Math.log1p(ctx.doc.text.length),
        ctx.candidates.length,
        msg.distinctCodes,
        ctx.candidates.indexOf(c)
    ];
}

export function candidateFeatures(ctx: DocContext, msg: MessageContext, c: Candidate): number[] {
    const text = ctx.doc.text;
    const lineStart = text.lastIndexOf('\n', c.start - 1) + 1;
    const line = lineAround(text, c.start, c.end);
    const row = [
        ...shapeFeatures(c),
        ...surroundingFeatures(text, c),
        ...keywordFeatures(ctx, c, line, lineStart),
        ...layoutFeatures(ctx, c, line),
        ...messageFeatures(ctx, msg, c),
        ...promoFeatures(ctx, msg, c, line, lineStart),
        vowelRatio(c.code),
        Math.max(0, ...(c.code.match(/[A-Za-z]+/g) ?? []).map(run => run.length)),
        (c.code.match(/[a-z](?=[A-Z])|[A-Z](?=[a-z])/g) ?? []).length
    ];
    if (row.length !== FEATURE_NAMES.length) {
        throw new Error(`feature vector has ${row.length} values, expected ${FEATURE_NAMES.length}`);
    }
    return row;
}
