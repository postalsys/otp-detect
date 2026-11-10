import type { MessageInput } from './analyze.js';
import { analyze } from './analyze.js';
import type { Model } from './model.js';
import { checkModel, predict } from './model.js';
import { MODEL } from './model-data.js';

export type { MessageInput } from './analyze.js';
export type { Model } from './model.js';

export type OtpCandidate = {
    /** The code as it should be typed */
    code: string;
    /** The code as printed in the message */
    raw: string;
    /** Probability, 0 to 1, that this is the one-time code */
    score: number;
    /** Which body the best occurrence was found in */
    source: 'html' | 'text';
};

export type DetectOptions = {
    /** Minimum score for a code to be returned. Defaults to the threshold the model was tuned with */
    threshold?: number;
    /** Use a different trained model */
    model?: Model;
};

// Models already checked against FEATURE_NAMES
const checked = new WeakSet<Model>();

function scored(input: MessageInput, model: Model): OtpCandidate[] {
    if (!checked.has(model)) {
        checkModel(model);
        checked.add(model);
    }
    // The same code printed several times counts once, with its best score
    const best = new Map<string, OtpCandidate>();
    for (const occ of analyze(input)) {
        const score = predict(model, occ.features);
        const prev = best.get(occ.candidate.code);
        if (!prev || score > prev.score) {
            best.set(occ.candidate.code, { code: occ.candidate.code, raw: occ.candidate.raw, score, source: occ.source });
        }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
}

/**
 * Every code-like token in the message with its score, best first. Meant for debugging and for
 * callers that want to apply their own rules.
 */
export function scoreCandidates(input: MessageInput, options: DetectOptions = {}): OtpCandidate[] {
    return scored(input, options.model ?? MODEL);
}

/**
 * Finds the one-time code in a parsed email, or returns null. The message is not trusted: check
 * that it is authenticated (DKIM aligned with the sender) before offering the code to a user.
 * Codes from an `OTP-Token` header (postal-mime `message.otp`) should be preferred when present.
 */
export function detectOtp(input: MessageInput, options: DetectOptions = {}): OtpCandidate | null {
    const model = options.model ?? MODEL;
    const threshold = options.threshold ?? model.threshold;
    const top = scored(input, model)[0];
    return top && top.score >= threshold ? top : null;
}

export default { detectOtp, scoreCandidates };
