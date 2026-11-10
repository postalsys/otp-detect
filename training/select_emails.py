#!/usr/bin/env python3
"""Merge label passes and copy the selected emails out of the corpus.

The final label of an email is the strong-model (pass 2) label when there is one, otherwise the
cheap-model (pass 1) label. Writes the merged labels as `final.jsonl` and copies:

- emails labeled `otp` with at least one verified code into `<out>/otp/`
- other prefilter candidates into `<out>/hard-negative/` (order numbers, promo codes, magic links,
  codes in quoted history; the detector must stay quiet on these)
- the random sample of emails the prefilter rejected into `<out>/random-negative/`, for measuring
  the false positive rate on ordinary mail

Copies keep the corpus file name. Existing copies are left alone, stale ones are removed, so the
output directories always mirror the current labels.

    python3 -I training/select_emails.py ../otp-data/labels ../otp-data/emails
"""

import argparse
import glob
import json
import os
import shutil


BUCKETS = ("otp", "hard-negative", "random-negative")


def load(pattern):
    rows = {}
    for path in sorted(glob.glob(pattern)):
        source = "random" if "rejected" in os.path.basename(path) else "candidate"
        for line in open(path):
            if line.strip():
                row = json.loads(line)
                rows[row["path"]] = {**row, "source": source}
    return rows


def bucket(row):
    if row["kind"] == "otp" and any(c["verified"] for c in row["codes"]):
        return "otp"
    return "random-negative" if row["source"] == "random" else "hard-negative"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("labels", help="directory with pass1-*.jsonl and pass2-*.jsonl")
    ap.add_argument("out", help="directory to copy emails into")
    args = ap.parse_args()

    merged = load(os.path.join(args.labels, "pass1-*.jsonl"))
    for path, row in load(os.path.join(args.labels, "pass2-*.jsonl")).items():
        first = merged.get(path, {})
        merged[path] = {**row, "source": first.get("source", row["source"]), "pass1": {k: first.get(k) for k in ("kind", "codes", "model")}}

    with open(os.path.join(args.labels, "final.jsonl"), "w") as fh:
        for path in sorted(merged):
            row = merged[path]
            row["bucket"] = bucket(row)
            row["file"] = f"{row['bucket']}/{os.path.basename(path)}"
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    counts = {}
    for name in BUCKETS:
        target = os.path.join(args.out, name)
        os.makedirs(target, exist_ok=True)
        wanted = {os.path.basename(p): p for p, r in merged.items() if r["bucket"] == name}
        for stale in set(os.listdir(target)) - set(wanted):
            os.remove(os.path.join(target, stale))
        for base, src in wanted.items():
            dst = os.path.join(target, base)
            if not os.path.exists(dst):
                shutil.copy2(src, dst)
        counts[name] = len(wanted)
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
