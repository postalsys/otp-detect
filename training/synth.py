#!/usr/bin/env python3
"""Generate synthetic training emails with an LLM: one-time code emails and look-alikes.

The real corpus is one mailbox: mostly English and Estonian, about a hundred OTP senders. This
fills the gaps with emails from fictional services in many languages, code formats and layouts.
For OTP emails the code is chosen here and handed to the model, so the label is known exactly;
an email whose code does not survive into the output is dropped. Negative emails carry the kinds
of numbers and codes the detector must not return (order numbers, promo codes, tracking IDs).

Each spec is derived from a seed, so a run with the same --seed and --count produces the same
specs and an interrupted run resumes where it stopped.

    OPENAI_API_KEY=... python3 -I training/synth.py ../otp-data/synthetic/emails.jsonl --count 1500
"""

import argparse
import json
import os
import random
import re
import string
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from label import call, squash  # noqa: E402

LANGUAGES = {
    "en": "English",
    "et": "Estonian",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "pt": "Portuguese (Brazil)",
    "it": "Italian",
    "nl": "Dutch",
    "sv": "Swedish",
    "fi": "Finnish",
    "pl": "Polish",
    "ru": "Russian",
    "lv": "Latvian",
    "lt": "Lithuanian",
    "ja": "Japanese",
    "zh": "Simplified Chinese",
    "tr": "Turkish",
}
# English and Estonian are already well covered by the real corpus
LANGUAGE_WEIGHTS = {code: (0.5 if code in ("en", "et") else 1.0) for code in LANGUAGES}

OTP_PURPOSES = [
    "sign-in code for a new device",
    "email address verification when signing up",
    "two-factor authentication code",
    "password reset code",
    "payment or transaction approval code",
    "code to confirm a change of email address or phone number",
    "code to link a TV or another device to the account",
]

NEGATIVE_KINDS = [
    "promotional email with a discount or promo code in capitals (the code is NOT a one-time code)",
    "referral email inviting friends with a personal referral code",
    "order confirmation with an order number, item SKUs, prices and a customer number",
    "shipping notification with a tracking number and a parcel locker pickup PIN",
    "invoice or receipt with an invoice number, reference number, VAT number and amounts",
    "sign-in link email (magic link) with a button and NO code",
    "security alert about a new sign-in from a device and location, with NO code",
    "booking or ticket confirmation with a booking reference and seat numbers",
    "newsletter with dates, prices, statistics and a webinar registration code",
    "welcome email with an account ID and a customer support PIN for phone calls",
    "meeting invitation with a meeting ID and a meeting passcode",
    "gift card email with a gift card code and PIN",
]

INDUSTRIES = [
    "bank",
    "online store",
    "game platform",
    "social network",
    "cloud storage",
    "streaming service",
    "airline",
    "food delivery",
    "government e-service",
    "crypto exchange",
    "developer tool",
    "telecom operator",
    "insurance company",
    "university portal",
    "dating app",
    "ride hailing app",
    "energy utility",
    "email provider",
    "health clinic portal",
    "marketplace",
]

LAYOUTS = [
    "HTML: the code alone in a large, bold, letter-spaced block",
    "HTML: the code inside a sentence, in bold",
    "HTML: each character of the code in its own table cell, side by side",
    "HTML: the code in a light grey box with a monospace font",
    "plain text only (no HTML)",
    "HTML with a hidden preheader text at the top, the code in a large heading",
    "HTML: the code in the subject line too, and in the body",
]


def make_code(rng):
    kind = rng.choices(
        ["d6", "d4", "d5", "d7", "d8", "grouped", "dashed", "upper_alnum", "letters", "mixed_long"],
        weights=[40, 6, 6, 4, 8, 8, 6, 10, 5, 7],
    )[0]
    digits = lambda n: "".join(rng.choice(string.digits) for _ in range(n))  # noqa: E731
    if re.fullmatch(r"d\d", kind):
        return digits(int(kind[1:])), kind
    if kind == "grouped":
        return f"{digits(3)} {digits(3)}", kind
    if kind == "dashed":
        return f"{digits(3)}-{digits(3)}", kind
    if kind == "upper_alnum":
        n = rng.choice([6, 7, 8])
        code = "".join(rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(n))
        return (code if re.search(r"\d", code) else code[:-1] + "7"), kind
    if kind == "letters":
        return "".join(rng.choice("BCDFGHJKLMNPQRSTVWXZ") for _ in range(5)), kind
    n = rng.choice([10, 12, 16])
    pool = string.ascii_letters + string.digits
    return "".join(rng.choice(pool) for _ in range(n)) + rng.choice(string.digits), kind


def make_spec(i, seed):
    rng = random.Random(f"{seed}:{i}")
    lang = rng.choices(list(LANGUAGES), weights=[LANGUAGE_WEIGHTS[c] for c in LANGUAGES])[0]
    spec = {
        "id": f"s{seed}-{i:05d}",
        "lang": lang,
        "layout": rng.choice(LAYOUTS),
        "industry": rng.choice(INDUSTRIES),
        "initial": rng.choice("ABCDEFGHIKLMNOPRSTUVWZ"),
    }
    if rng.random() < 0.5:
        code, fmt = make_code(rng)
        spec.update({"type": "otp", "purpose": rng.choice(OTP_PURPOSES), "code": code, "format": fmt})
    else:
        spec.update({"type": "negative", "kind": rng.choice(NEGATIVE_KINDS)})
    # Some negatives also look like security mail, some OTP mails also carry other numbers
    spec["extras"] = rng.random() < 0.5
    return spec


INSTRUCTIONS = """You write realistic transactional emails for a test dataset. Write like the real
email team of the company would, in the requested language, with the usual structure: greeting,
explanation, the main content, safety notes, footer with company address, links and legal text.

Rules:
- Invent the company: a fictional name and product that does not exist. Never use a real brand.
- Use example.com style domains and fictional street addresses and phone numbers.
- The HTML must be a complete email body with inline styles, like real email HTML (tables are fine).
- Also return a plain text version, unless the layout says plain text only (then html is "").
- If a one-time code is given, it must appear in the email exactly as given (same characters,
  same spaces or dashes), unless the layout puts each character in its own table cell.
- Never include any other one-time code than the one given.
"""

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["service", "subject", "html", "text"],
    "properties": {
        "service": {"type": "string"},
        "subject": {"type": "string"},
        "html": {"type": "string"},
        "text": {"type": "string"},
    },
}


def brief(spec):
    lines = [
        f"Language: {LANGUAGES[spec['lang']]}",
        f"Layout: {spec['layout']}",
        f"Company: a fictional {spec['industry']} whose name starts with {spec['initial']}",
    ]
    if spec["type"] == "otp":
        lines.append(f"Email type: one-time code email, {spec['purpose']}.")
        lines.append(f"The one-time code: {spec['code']}")
        lines.append("Say how long the code is valid and that the recipient should not share it.")
        if spec["extras"]:
            lines.append("Also mention an account or customer number, a date and a support phone number somewhere.")
    else:
        lines.append(f"Email type: {spec['kind']}.")
        lines.append("Include several realistic numbers and codes that fit this kind of email.")
        if spec["extras"]:
            lines.append("Mention account security or verification in passing (for example a link to security settings).")
    return "\n".join(lines)


def generate(spec, model, key):
    out, usage = call(model, "low", brief(spec), key, instructions=INSTRUCTIONS, schema=SCHEMA, name="synthetic_email")
    if spec["type"] == "otp":
        # The code must survive, either verbatim or as one character per cell
        body = (out["html"] or "") + "\n" + (out["text"] or "")
        if squash(spec["code"]) not in squash(re.sub(r"<[^>]*>", "", body)):
            return None, usage
    return {**spec, **out}, usage


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output")
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--model", default="gpt-5.6-sol")
    ap.add_argument("--concurrency", type=int, default=16)
    args = ap.parse_args()

    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        sys.exit("OPENAI_API_KEY is not set")
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    done = set()
    if os.path.exists(args.output):
        done = {json.loads(line)["id"] for line in open(args.output) if line.strip()}
    specs = [s for s in (make_spec(i, args.seed) for i in range(args.count)) if s["id"] not in done]
    print(f"{len(done)} done, {len(specs)} to generate", file=sys.stderr)

    stats = {"ok": 0, "dropped": 0, "failed": 0, "output_tokens": 0}
    with open(args.output, "a") as fh, ThreadPoolExecutor(args.concurrency) as pool:
        futures = {pool.submit(generate, s, args.model, key): s for s in specs}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                row, usage = fut.result()
            except Exception as err:
                stats["failed"] += 1
                print(f"FAILED {futures[fut]['id']}: {err}", file=sys.stderr)
                continue
            stats["output_tokens"] += usage.get("output_tokens") or 0
            if row is None:
                stats["dropped"] += 1
                continue
            stats["ok"] += 1
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
            fh.flush()
            if i % 100 == 0:
                print(f"{i}/{len(specs)} {stats}", file=sys.stderr, flush=True)
    print(f"done {stats}", file=sys.stderr)


if __name__ == "__main__":
    main()
