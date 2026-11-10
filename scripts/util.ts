// Helpers shared by the offline scripts.

import fs from 'node:fs';

/** Whether a candidate code is the labeled code: separators and case do not count */
export function sameCode(candidate: string, label: string): boolean {
    const norm = (s: string) => s.replace(/[\s-]/g, '').toLowerCase();
    return norm(candidate) === norm(label);
}

export function readJsonl<T>(file: string): T[] {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as T);
}
