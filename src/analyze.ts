// Shared by the library and the training data dump, so that both compute features the same way.

import type { Candidate } from './candidates.js';
import { extractCandidates } from './candidates.js';
import type { Doc } from './doc.js';
import { renderText } from './doc.js';
import { candidateFeatures, docContext, messageContext } from './features.js';
import { renderHtml } from './html.js';

export type MessageInput = {
    subject?: string | undefined;
    /** The text/plain body */
    text?: string | undefined;
    /** The text/html body */
    html?: string | undefined;
};

export type Occurrence = {
    candidate: Candidate;
    source: Doc['source'];
    features: number[];
};

/** Bodies larger than this are cut; code notifications are a few kilobytes */
export const MAX_BODY_CHARS = 512 * 1024;

export function renderDocs(input: MessageInput): Doc[] {
    const docs: Doc[] = [];
    if (input.html) {
        docs.push(renderHtml(input.html.slice(0, MAX_BODY_CHARS)));
    }
    if (input.text) {
        docs.push(renderText(input.text.slice(0, MAX_BODY_CHARS)));
    }
    return docs.filter(d => d.text.length > 0);
}

export function analyze(input: MessageInput): Occurrence[] {
    const docs = renderDocs(input);
    const perDoc = docs.map(doc => ({ doc, candidates: extractCandidates(doc) }));
    const distinctCodes = new Set(perDoc.flatMap(d => d.candidates.map(c => c.code))).size;
    const subject = (input.subject ?? '').slice(0, 1000);
    const out: Occurrence[] = [];
    for (const { doc, candidates } of perDoc) {
        const ctx = docContext(doc, candidates);
        const otherText = docs
            .filter(d => d !== doc)
            .map(d => d.text)
            .join('\n');
        const msg = messageContext(subject, otherText, distinctCodes);
        candidates.forEach((candidate, i) => {
            out.push({ candidate, source: doc.source, features: candidateFeatures(ctx, msg, i) });
        });
    }
    return out;
}
