// Evaluates the gradient boosted trees exported by training/train.py.

import { FEATURE_NAMES } from './features.js';

/**
 * One tree in flat arrays. Internal node i compares feature[i] with threshold[i]: values less
 * than or equal go left. A child index >= 0 is another internal node, a negative index c is the
 * leaf ~c (that is -c - 1) in `leaves`.
 */
export type Tree = {
    feature: number[];
    threshold: number[];
    left: number[];
    right: number[];
    leaves: number[];
};

export type Model = {
    version: string;
    featureNames: readonly string[];
    trees: Tree[];
    /** Default decision threshold on the probability, picked on held-out data */
    threshold: number;
};

export function checkModel(model: Model): void {
    const names = model.featureNames;
    if (names.length !== FEATURE_NAMES.length || names.some((n, i) => n !== FEATURE_NAMES[i])) {
        throw new Error('The model was trained on a different feature list than this version computes');
    }
}

function evalTree(tree: Tree, row: number[]): number {
    if (tree.feature.length === 0) {
        return tree.leaves[0] ?? 0;
    }
    let node = 0;
    for (;;) {
        const value = row[tree.feature[node]];
        const next = value <= tree.threshold[node] ? tree.left[node] : tree.right[node];
        if (next < 0) {
            return tree.leaves[-next - 1];
        }
        node = next;
    }
}

/** Probability that the candidate is the one-time code */
export function predict(model: Model, row: number[]): number {
    let sum = 0;
    for (const tree of model.trees) {
        sum += evalTree(tree, row);
    }
    return 1 / (1 + Math.exp(-sum));
}
