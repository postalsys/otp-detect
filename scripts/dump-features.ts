// Writes one JSON line per candidate occurrence in the labeled emails of the private otp-data
// repository, with the label and the feature vector the library computes. training/train.py fits
// the model on this file.
//
//   npm run dump-features -- ../otp-data
//
// Output: <data>/features/features.jsonl and <data>/features/coverage.json

import fs from 'node:fs';
import path from 'node:path';
import PostalMime from 'postal-mime';
import { analyze } from '../src/analyze.js';
import { FEATURE_NAMES } from '../src/features.js';

type Label = { file: string; bucket: string; service?: string; codes: { code: string; verified: boolean }[] };

const squash = (s: string) => s.replace(/[\s\- ]/g, '');

function senderGroup(address: string | undefined): string {
    const domain = (address ?? '').split('@').pop()?.toLowerCase() ?? '';
    // Group by registrable domain so that one service's mails never end up on both sides of a split
    return domain.split('.').slice(-2).join('.') || 'unknown';
}

async function main(): Promise<void> {
    const dataDir = path.resolve(process.argv[2] ?? '../otp-data');
    const labels: Label[] = fs
        .readFileSync(path.join(dataDir, 'labels/final.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Label);
    const outDir = path.join(dataDir, 'features');
    fs.mkdirSync(outDir, { recursive: true });
    const out = fs.createWriteStream(path.join(outDir, 'features.jsonl'));
    out.write(JSON.stringify({ featureNames: FEATURE_NAMES }) + '\n');

    const coverage = { otpEmails: 0, otpCovered: 0, rows: 0, positives: 0 };
    for (const label of labels) {
        const email = await PostalMime.parse(fs.readFileSync(path.join(dataDir, 'emails', label.file)));
        const occurrences = analyze({ subject: email.subject, text: email.text, html: email.html });
        const codes = new Set(label.bucket === 'otp' ? label.codes.filter(c => c.verified).map(c => squash(c.code)) : []);
        const codesLower = new Set([...codes].map(c => c.toLowerCase()));
        let covered = false;
        for (const occ of occurrences) {
            const code = squash(occ.candidate.code);
            const positive = codes.has(code) || codesLower.has(code.toLowerCase());
            covered ||= positive;
            coverage.rows++;
            coverage.positives += Number(positive);
            out.write(
                JSON.stringify({
                    file: label.file,
                    bucket: label.bucket,
                    group: senderGroup(email.from?.address),
                    code: occ.candidate.code,
                    label: Number(positive),
                    x: occ.features
                }) + '\n'
            );
        }
        if (label.bucket === 'otp') {
            coverage.otpEmails++;
            coverage.otpCovered += Number(covered);
            if (!covered) {
                console.error(`not covered: ${label.file}`);
            }
        }
    }
    await new Promise<void>(resolve => out.end(resolve));
    fs.writeFileSync(path.join(outDir, 'coverage.json'), JSON.stringify(coverage, null, 2) + '\n');
    console.log(coverage);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
