// Runs the detector over every .eml file in a directory and writes one JSON line per email where
// it answers above --min-score. Used to measure precision on mail the model was not trained on,
// and to find OTP emails the prefilter missed.
//
//   node --import tsx scripts/scan-corpus.ts <corpus dir> <out.jsonl> [--min-score 0.3] [--workers 16]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import PostalMime from 'postal-mime';
import { scoreCandidates } from '../src/index.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

type Job = { files: string[]; minScore: number };

async function work(job: Job): Promise<void> {
    for (const file of job.files) {
        let line: string | null = null;
        try {
            if (fs.statSync(file).size <= MAX_FILE_BYTES) {
                const email = await PostalMime.parse(fs.readFileSync(file));
                const top = scoreCandidates({ subject: email.subject, text: email.text, html: email.html })[0];
                if (top && top.score >= job.minScore) {
                    line = JSON.stringify({
                        path: file,
                        code: top.code,
                        score: Math.round(top.score * 1000) / 1000,
                        subject: (email.subject ?? '').slice(0, 200)
                    });
                }
            }
        } catch (err) {
            line = JSON.stringify({ path: file, error: String(err).slice(0, 200) });
        }
        parentPort?.postMessage(line);
    }
}

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(name);
    return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
    const [dir, outPath] = process.argv.slice(2);
    if (!dir || !outPath) {
        throw new Error('usage: scan-corpus.ts <corpus dir> <out.jsonl> [--min-score 0.3] [--workers 16]');
    }
    const minScore = parseFloat(arg('--min-score', '0.3'));
    const workers = parseInt(arg('--workers', String(Math.max(1, os.cpus().length - 2))), 10);
    const files = fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.eml'))
        .sort()
        .map(f => path.join(dir, f));
    const out = fs.createWriteStream(outPath);
    let done = 0;
    let found = 0;
    const self = fileURLToPath(import.meta.url);
    await Promise.all(
        Array.from({ length: workers }, (_, w) => {
            const share = files.filter((_f, i) => i % workers === w);
            return new Promise<void>((resolve, reject) => {
                const worker = new Worker(self, { workerData: { files: share, minScore }, execArgv: ['--import', 'tsx'] });
                worker.on('message', (line: string | null) => {
                    done++;
                    if (line) {
                        found++;
                        out.write(line + '\n');
                    }
                    if (done % 20000 === 0) {
                        console.error(`${done}/${files.length} answered=${found}`);
                    }
                });
                worker.on('error', reject);
                worker.on('exit', code => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
            });
        })
    );
    await new Promise<void>(resolve => out.end(resolve));
    console.error(`done ${done} scanned, ${found} answered`);
}

if (isMainThread) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    work(workerData as Job).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
