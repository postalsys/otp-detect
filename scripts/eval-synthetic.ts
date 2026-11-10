// Scores the current model on a synthetic email file and prints per-language results. Synthetic
// emails come from fictional services, so this measures generalization to new senders and
// languages, not accuracy on real mail.
//
//   node --import tsx scripts/eval-synthetic.ts ../otp-data/synthetic/holdout.jsonl [--verbose]

import { detectOtp } from '../src/index.js';
import { readJsonl, sameCode } from './util.js';

type Row = { id: string; lang: string; type: 'otp' | 'negative'; code?: string; subject: string; html: string; text: string; kind?: string };

function main(): void {
    const file = process.argv[2];
    if (!file) {
        throw new Error('usage: eval-synthetic.ts <emails.jsonl> [--verbose]');
    }
    const verbose = process.argv.includes('--verbose');
    const rows = readJsonl<Row>(file);
    const stats = new Map<string, { otp: number; correct: number; wrong: number; neg: number; fp: number }>();
    for (const row of rows) {
        const s = stats.get(row.lang) ?? { otp: 0, correct: 0, wrong: 0, neg: 0, fp: 0 };
        stats.set(row.lang, s);
        const result = detectOtp({ subject: row.subject, html: row.html || undefined, text: row.text || undefined });
        if (row.type === 'otp') {
            s.otp++;
            const ok = result !== null && sameCode(result.code, row.code ?? '');
            s.correct += Number(ok);
            s.wrong += Number(result !== null && !ok);
            if (verbose && !ok) {
                console.log(`MISS ${row.id} ${row.lang} want ${row.code} got ${result?.code ?? '-'} ${result?.score.toFixed(2) ?? ''}`);
            }
        } else {
            s.neg++;
            s.fp += Number(result !== null);
            if (verbose && result) {
                console.log(`FP   ${row.id} ${row.lang} ${result.code} ${result.score.toFixed(2)} ${row.kind?.slice(0, 40)}`);
            }
        }
    }
    const total = { otp: 0, correct: 0, wrong: 0, neg: 0, fp: 0 };
    for (const [lang, s] of [...stats].sort()) {
        console.log(`${lang}  correct ${s.correct}/${s.otp}  wrong ${s.wrong}  fp ${s.fp}/${s.neg}`);
        for (const k of Object.keys(total) as (keyof typeof total)[]) {
            total[k] += s[k];
        }
    }
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '0.0');
    console.log(
        `all correct ${total.correct}/${total.otp} (${pct(total.correct, total.otp)}%)  wrong ${total.wrong}  fp ${total.fp}/${total.neg} (${pct(total.fp, total.neg)}%)`
    );
}

main();
