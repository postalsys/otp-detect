// Writes one JSON line per candidate occurrence in the labeled emails of the private otp-data
// repository, with the label and the feature vector the library computes. training/train.py fits
// the model on this file.
//
//   npm run dump-features -- ../otp-data [--synthetic ../otp-data/synthetic/train.jsonl]
//
// Synthetic emails get the buckets synthetic-otp and synthetic-negative and the group "synthetic";
// train.py always trains on them and never scores them.
//
// Output: <data>/features/features.jsonl and <data>/features/coverage.json

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import PostalMime from 'postal-mime';
import type { MessageInput } from '../src/analyze.js';
import { analyze } from '../src/analyze.js';
import { FEATURE_NAMES } from '../src/features.js';
import { readJsonl, sameCode } from './util.js';

type Label = { file: string; bucket: string; codes: { code: string; verified: boolean }[] };
type SyntheticRow = { id: string; type: 'otp' | 'negative'; code?: string; subject: string; html: string; text: string };
type Meta = { file: string; bucket: string; group: string; synthetic: boolean };

const coverage = { otpEmails: 0, otpCovered: 0, rows: 0, positives: 0, synthetic: 0, syntheticCovered: 0 };

function senderGroup(address: string | undefined): string {
    const domain = (address ?? '').split('@').pop()?.toLowerCase() ?? '';
    // Group by registrable domain so that one service's mails never end up on both sides of a split
    return domain.split('.').slice(-2).join('.') || 'unknown';
}

/** Writes one row per candidate occurrence, returns whether any of them is a labeled code */
function dumpEmail(out: fs.WriteStream, input: MessageInput, meta: Meta, codes: string[]): boolean {
    let covered = false;
    for (const occ of analyze(input)) {
        const positive = codes.some(code => sameCode(occ.candidate.code, code));
        covered ||= positive;
        coverage.rows++;
        coverage.positives += Number(positive);
        out.write(JSON.stringify({ ...meta, code: occ.candidate.code, label: Number(positive), x: occ.features }) + '\n');
    }
    return covered;
}

async function dumpLabeled(dataDir: string, out: fs.WriteStream): Promise<void> {
    for (const label of readJsonl<Label>(path.join(dataDir, 'labels/final.jsonl'))) {
        const email = await PostalMime.parse(fs.readFileSync(path.join(dataDir, 'emails', label.file)));
        const codes = label.bucket === 'otp' ? label.codes.filter(c => c.verified).map(c => c.code) : [];
        const meta = { file: label.file, bucket: label.bucket, group: senderGroup(email.from?.address), synthetic: false };
        const covered = dumpEmail(out, { subject: email.subject, text: email.text, html: email.html }, meta, codes);
        if (label.bucket === 'otp') {
            coverage.otpEmails++;
            coverage.otpCovered += Number(covered);
            if (!covered) {
                console.error(`not covered: ${label.file}`);
            }
        }
    }
}

function dumpSynthetic(file: string, out: fs.WriteStream): void {
    for (const row of readJsonl<SyntheticRow>(file)) {
        const isOtp = row.type === 'otp';
        const meta = { file: `synthetic/${row.id}`, bucket: isOtp ? 'synthetic-otp' : 'synthetic-negative', group: 'synthetic', synthetic: true };
        const input = { subject: row.subject, html: row.html || undefined, text: row.text || undefined };
        const covered = dumpEmail(out, input, meta, isOtp ? [row.code ?? ''] : []);
        if (isOtp) {
            coverage.synthetic++;
            coverage.syntheticCovered += Number(covered);
        }
    }
}

async function main(): Promise<void> {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { synthetic: { type: 'string' } } });
    const dataDir = path.resolve(positionals[0] ?? '../otp-data');
    const outDir = path.join(dataDir, 'features');
    fs.mkdirSync(outDir, { recursive: true });
    const out = fs.createWriteStream(path.join(outDir, 'features.jsonl'));
    out.write(JSON.stringify({ featureNames: FEATURE_NAMES }) + '\n');
    await dumpLabeled(dataDir, out);
    if (values.synthetic) {
        dumpSynthetic(values.synthetic, out);
    }
    await new Promise<void>(resolve => out.end(resolve));
    fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
    console.log(coverage);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
