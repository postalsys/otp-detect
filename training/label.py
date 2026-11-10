#!/usr/bin/env python3
"""Label prefilter candidates with an LLM: is this a one-time code email, and what is the code.

Reads JSON lines with a `path` field (prefilter output), sends each email's subject, sender and
visible text to the OpenAI Responses API with a strict JSON schema, and appends one result line
per email to the output file. Already labeled paths are skipped, so an interrupted run resumes.

Every code the model returns is checked against the text it was shown. A code that does not
occur verbatim (ignoring spaces and dashes inside it) is kept but flagged `verified: false`,
so hallucinated codes never become training targets silently.

The API key comes from OPENAI_API_KEY. Standard library only.

    OPENAI_API_KEY=... python3 -I training/label.py ../otp-data/scan/candidates.jsonl ../otp-data/labels/candidates.jsonl
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from email import policy
from email.parser import BytesParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from prefilter import SPACE_RE, header, html_to_text, split_bodies  # noqa: E402

API_URL = "https://api.openai.com/v1/responses"
MAX_PART_CHARS = 8000

PROMPT = """You label emails for a dataset that trains a detector of one-time codes.

A one-time code (OTP) is a short secret the recipient is asked to type or paste somewhere to prove
they control this mailbox or account, valid for one use or a short time: login and sign-in codes,
verification and confirmation codes, two-factor codes, Steam Guard style codes, account recovery or
password reset codes, payment or transaction approval codes, device pairing codes.

NOT one-time codes: order, invoice, ticket, booking or tracking numbers; discount or promo codes;
gift card codes; permanent PINs or passwords sent for ongoing use; parcel locker, pickup point or
door opening PINs; event ticket or redemption codes; meeting passcodes; invite or beta access
codes; domain transfer (EPP) authorization codes; license or registration keys; links (magic links count as
`magic_link`, not `otp`); phone numbers, prices, dates, customer IDs; codes in quoted reply history
of a conversation, in forwarded messages, in mailing list discussion, or in source code and logs.

Return:
- kind: "otp" if the email delivers at least one one-time code meant for the recipient, "magic_link"
  if it only offers a one-time sign-in or verification link, otherwise "other".
- codes: every one-time code delivered, copied EXACTLY as printed (keep case, spaces or dashes
  inside the code as printed). Empty unless kind is "otp".
- purpose of each code: login, verification, two_factor, password_reset, transaction, device, other.
- service: the company or product that sent the code, or "" if unknown.
- language: ISO 639-1 code of the email's main language.
- confidence: 0 to 1.
- note: one short sentence if anything is ambiguous, otherwise "".
"""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["kind", "codes", "service", "language", "confidence", "note"],
    "properties": {
        "kind": {"type": "string", "enum": ["otp", "magic_link", "other"]},
        "codes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["code", "purpose"],
                "properties": {
                    "code": {"type": "string"},
                    "purpose": {"type": "string", "enum": ["login", "verification", "two_factor", "password_reset", "transaction", "device", "other"]},
                },
            },
        },
        "service": {"type": "string"},
        "language": {"type": "string"},
        "confidence": {"type": "number"},
        "note": {"type": "string"},
    },
}


def email_view(path):
    """The text the model sees: headers it needs plus both body representations, truncated."""
    with open(path, "rb") as fh:
        msg = BytesParser(policy=policy.default).parse(fh)
    plain, html = split_bodies(msg)
    rich = [html_to_text(h) for h in html]

    def tidy(chunks):
        text = SPACE_RE.sub(" ", "\n".join(chunks))
        text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
        return text[:MAX_PART_CHARS]

    sections = [f"From: {header(msg, 'from')}", f"Subject: {header(msg, 'subject')}", f"Date: {header(msg, 'date')}"]
    if plain:
        sections.append("--- text/plain ---\n" + tidy(plain))
    if rich:
        sections.append("--- text/html (rendered) ---\n" + tidy(rich))
    return "\n".join(sections)


def squash(value):
    """A code without whitespace (no-break spaces included) or dashes"""
    return re.sub(r"[\s-]", "", value)


def call(model, effort, view, key, retries=6, instructions=PROMPT, schema=SCHEMA, name="otp_label"):
    body = {
        "model": model,
        "instructions": instructions,
        "input": view,
        "text": {"format": {"type": "json_schema", "name": name, "strict": True, "schema": schema}},
        "store": False,
    }
    if effort:
        body["reasoning"] = {"effort": effort}
    data = json.dumps(body).encode()
    for attempt in range(retries):
        req = urllib.request.Request(API_URL, data=data, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                out = json.load(res)
            text = "".join(c.get("text", "") for o in out.get("output", []) if o.get("type") == "message" for c in o.get("content", []))
            return json.loads(text), out.get("usage", {})
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503, 504) or attempt == retries - 1:
                raise RuntimeError(f"HTTP {err.code}: {err.read()[:300]!r}") from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == retries - 1:
                raise
        time.sleep(2**attempt)
    raise RuntimeError("unreachable")


def label_one(path, args, key):
    view = email_view(path)
    result, usage = call(args.model, args.effort, view, key)
    haystack = squash(view)
    for code in result["codes"]:
        code["verified"] = bool(code["code"]) and squash(code["code"]) in haystack
    return {"path": path, "model": args.model, **result, "usage": {k: usage.get(k) for k in ("input_tokens", "output_tokens")}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="JSON lines with a `path` field")
    ap.add_argument("output", help="JSON lines to append results to")
    ap.add_argument("--model", default="gpt-5.6-sol")
    ap.add_argument("--effort", default="low", help='reasoning effort, "" for none')
    ap.add_argument("--concurrency", type=int, default=16)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        sys.exit("OPENAI_API_KEY is not set")

    paths = [json.loads(line)["path"] for line in open(args.input)]
    done = set()
    if os.path.exists(args.output):
        done = {json.loads(line)["path"] for line in open(args.output) if line.strip()}
    todo = [p for p in paths if p not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(paths)} inputs, {len(done)} already labeled, {len(todo)} to go", file=sys.stderr)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    tokens = {"input": 0, "output": 0}
    failed = 0
    with open(args.output, "a") as out, ThreadPoolExecutor(args.concurrency) as pool:
        futures = {pool.submit(label_one, p, args, key): p for p in todo}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                row = fut.result()
            except Exception as err:
                failed += 1
                print(f"FAILED {futures[fut]}: {err}", file=sys.stderr)
                continue
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            tokens["input"] += row["usage"]["input_tokens"] or 0
            tokens["output"] += row["usage"]["output_tokens"] or 0
            if i % 100 == 0:
                print(f"{i}/{len(todo)} tokens={tokens} failed={failed}", file=sys.stderr, flush=True)
    print(f"done tokens={tokens} failed={failed}", file=sys.stderr)


if __name__ == "__main__":
    main()
