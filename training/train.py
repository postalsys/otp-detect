#!/usr/bin/env python3
"""Train the candidate scorer and export it as src/model-data.ts.

Input is the feature dump of scripts/dump-features.ts. Evaluation is per email, the way the
library is used: the best scoring candidate of an email is its answer, and the answer counts only
if it clears the threshold. Folds are grouped by sender domain, so a service's emails are never
on both sides of a split and the scores say how the model does on senders it has not seen.

For an OTP email the answer is correct, wrong (a different code) or missing. For any other email
an answer is a false positive. A wrong or false code shown to a user as their login code is the
worst outcome, which is why the shipped threshold (--threshold) is high.

    training/venv/bin/python training/train.py ../otp-data/features/features.jsonl src/model-data.ts
"""

import argparse
import json
from collections import defaultdict

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import StratifiedGroupKFold

PARAMS = {
    "objective": "binary",
    "learning_rate": 0.05,
    "num_leaves": 7,
    "min_child_samples": 20,
    "feature_fraction": 0.8,
    "bagging_fraction": 0.8,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
    "scale_pos_weight": 20,
    "verbose": -1,
    "seed": 1,
    "deterministic": True,
}
ROUNDS = 150


def load(path):
    with open(path) as fh:
        names = json.loads(fh.readline())["featureNames"]
        rows = [json.loads(line) for line in fh]
    x = np.array([r["x"] for r in rows], dtype=np.float64)
    y = np.array([r["label"] for r in rows])
    return names, rows, x, y


def per_email(rows, scores):
    """Best candidate of every email: file -> (bucket, best score, best is a positive, sender group)"""
    best = {}
    for r, s in zip(rows, scores):
        cur = best.get(r["file"])
        if cur is None or s > cur[1]:
            best[r["file"]] = (r["bucket"], s, r["label"] == 1, r["group"])
    return best


def outcomes(best, emails, threshold):
    count = defaultdict(int)
    fp_senders = set()
    for f, bucket in emails.items():
        b = best.get(f)
        answered = b is not None and b[1] >= threshold
        if bucket == "otp":
            count["otp"] += 1
            count["correct" if answered and b[2] else "wrong" if answered else "missed"] += 1
        else:
            count[bucket] += 1
            count[f"fp_{bucket}"] += int(answered)
            if answered:
                fp_senders.add(b[3])
    count["fp_senders"] = len(fp_senders)
    return count


def report(best, emails, threshold):
    c = outcomes(best, emails, threshold)
    otp = max(c["otp"], 1)
    return (
        f"thr={threshold:.3f} correct={c['correct']}/{c['otp']} ({c['correct'] / otp:.1%}) wrong={c['wrong']} missed={c['missed']} "
        f"fp_hard={c['fp_hard-negative']}/{c['hard-negative']} fp_random={c['fp_random-negative']}/{c['random-negative']} fp_senders={c['fp_senders']}"
    )


def report_mean(runs, emails, threshold):
    keys = ("correct", "wrong", "missed", "fp_hard-negative", "fp_random-negative", "fp_senders")
    totals = {k: np.mean([outcomes(b, emails, threshold)[k] for b in runs]) for k in keys}
    c = outcomes(runs[0], emails, threshold)
    return (
        f"thr={threshold:.2f} correct={totals['correct']:.1f}/{c['otp']} ({totals['correct'] / max(c['otp'], 1):.1%}) "
        f"wrong={totals['wrong']:.1f} missed={totals['missed']:.1f} fp_hard={totals['fp_hard-negative']:.1f}/{c['hard-negative']} "
        f"fp_random={totals['fp_random-negative']:.1f}/{c['random-negative']} fp_senders={totals['fp_senders']:.1f} (mean of {len(runs)})"
    )


def write_errors(rows, scores, emails, path):
    """Per email: the best candidate and, for OTP emails, the score of the true code"""
    top, true_best = {}, {}
    for r, s in zip(rows, scores):
        if r["file"] not in top or s > top[r["file"]][0]:
            top[r["file"]] = (s, r["code"], r["label"])
        if r["label"] == 1 and s > true_best.get(r["file"], (-1, ""))[0]:
            true_best[r["file"]] = (s, r["code"])
    with open(path, "w") as fh:
        for f, (s, code, label) in sorted(top.items(), key=lambda p: -p[1][0]):
            bucket = emails[f]
            if (bucket == "otp" and not label) or (bucket != "otp" and s >= 0.3):
                truth = true_best.get(f, (None, None))
                fh.write(json.dumps({"file": f, "bucket": bucket, "top": code, "topScore": round(s, 3), "true": truth[1], "trueScore": truth[0]}) + "\n")


def export_tree(node, tree):
    """Flattens a LightGBM tree_structure node, returns its child index for the parent"""
    if "leaf_value" in node:
        tree["leaves"].append(node["leaf_value"])
        return -len(tree["leaves"])
    if node.get("decision_type", "<=") != "<=":
        raise ValueError(f"unsupported decision type {node['decision_type']}")
    i = len(tree["feature"])
    tree["feature"].append(node["split_feature"])
    tree["threshold"].append(node["threshold"])
    tree["left"].append(None)
    tree["right"].append(None)
    tree["left"][i] = export_tree(node["left_child"], tree)
    tree["right"][i] = export_tree(node["right_child"], tree)
    return i


def write_model(booster, names, threshold, out_path, version):
    trees = []
    for info in booster.dump_model()["tree_info"]:
        tree = {"feature": [], "threshold": [], "left": [], "right": [], "leaves": []}
        export_tree(info["tree_structure"], tree)
        trees.append(tree)
    model = {"version": version, "featureNames": names, "trees": trees, "threshold": round(threshold, 4)}
    with open(out_path, "w") as fh:
        fh.write("// Generated by training/train.py. Do not edit.\n")
        fh.write("import type { Model } from './model.js';\n\n")
        fh.write("export const MODEL: Model = " + json.dumps(model, separators=(",", ":")) + ";\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("features")
    ap.add_argument("out", help="TypeScript module to write the model to")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--cv-seeds", type=int, default=3, help="cross-validation shuffles to average")
    ap.add_argument("--threshold", type=float, default=0.9, help="default decision threshold shipped with the model")
    ap.add_argument("--version", default="1")
    ap.add_argument("--email-weights", action="store_true", help="weight rows so every email counts the same")
    ap.add_argument("--errors", help="write the cross-validation errors as JSON lines here (private data)")
    args = ap.parse_args()

    names, rows, x, y = load(args.features)
    groups = np.array([r["group"] for r in rows])
    emails = {r["file"]: r["bucket"] for r in rows}
    print(f"{len(rows)} candidates, {int(y.sum())} positive, {len(emails)} emails with candidates")

    weights = np.ones(len(rows))
    if args.email_weights:
        per = defaultdict(int)
        for r in rows:
            per[r["file"]] += 1
        weights = np.array([1.0 / per[r["file"]] for r in rows])
        weights *= len(rows) / weights.sum()

    # Fold assignment moves a whole sender in or out of training, so one split is noisy: average
    # the per-email outcomes over several shuffles and keep the predictions of the first one
    runs = []
    for seed in range(args.cv_seeds):
        oof = np.zeros(len(rows))
        folds = StratifiedGroupKFold(n_splits=args.folds, shuffle=True, random_state=seed + 1)
        for tr, te in folds.split(x, y, groups):
            booster = lgb.train(PARAMS, lgb.Dataset(x[tr], y[tr], weight=weights[tr]), ROUNDS)
            oof[te] = booster.predict(x[te])
        runs.append(per_email(rows, oof))
        if seed == 0:
            first_oof = oof
    oof = first_oof
    best = runs[0]
    for t in (0.3, 0.5, 0.7, 0.9):
        print("cv", report_mean(runs, emails, t))
    threshold = args.threshold
    if args.errors:
        write_errors(rows, oof, emails, args.errors)
    print("cv shipped", report_mean(runs, emails, threshold))

    booster = lgb.train(PARAMS, lgb.Dataset(x, y, weight=weights), ROUNDS)
    gain = booster.feature_importance("gain")
    top = sorted(zip(names, gain), key=lambda p: -p[1])[:15]
    print("top features:", ", ".join(f"{n}={g:.0f}" for n, g in top))
    write_model(booster, names, threshold, args.out, args.version)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
