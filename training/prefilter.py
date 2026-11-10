#!/usr/bin/env python3
"""Recall-oriented prefilter: find emails in a corpus that might carry a one-time code.

Scans a directory of .eml files in parallel and writes one JSON line per candidate. It is
deliberately loose: the LLM labeling step decides what is really an OTP email, this step only
has to make that set small enough to label. A random sample of the rejected emails is written
as well so that the recall of this filter can be measured instead of assumed.

Standard library only, so it runs without a virtualenv.

    python3 -I training/prefilter.py ~/Data/EmailCorpus/gmail-eml ../otp-data/scan
"""

import argparse
import html
import json
import os
import random
import re
import sys
from email import policy
from email.parser import BytesParser
from multiprocessing import Pool

MAX_FILE_BYTES = 2 * 1024 * 1024  # bigger messages are attachments, not code notifications
MAX_TEXT_CHARS = 60_000

# Phrases that name a one-time code, in the languages the corpus is likely to contain.
# Matched case-insensitively against the subject and the visible body text.
KEYWORDS = [
    # English
    r"verification code", r"verify code", r"security code", r"confirmation code", r"one[- ]time (?:pass(?:code|word)|code|pin|password)",
    r"\botp\b", r"passcode", r"pass code", r"log ?in code", r"sign[- ]?in code", r"login code", r"access code", r"authentication code",
    r"auth code", r"\b2fa\b", r"two[- ]factor", r"2-step", r"two[- ]step", r"temporary (?:code|password|pin)", r"single[- ]use code",
    r"your code(?: is)?", r"code to (?:sign|log|verify|confirm|continue|complete)", r"enter (?:this|the following|the) code", r"\bpin code\b",
    r"\bcodes?\b", r"guard code", r"magic code", r"activation code", r"reset code", r"recovery code", r"device code", r"approval code",
    # Estonian
    r"kinnituskood", r"turvakood", r"ühekordne", r"sisselogimiskood", r"kontrollkood", r"autentimiskood", r"\bkood\b",
    # German
    r"bestätigungscode", r"sicherheitscode", r"einmalcode", r"einmal-?passwort", r"verifizierungscode", r"anmeldecode", r"\bihr code\b",
    r"zugangscode", r"prüfcode", r"\btan\b",
    # French
    r"code de (?:vérification|confirmation|sécurité|connexion|validation)", r"code à usage unique", r"votre code",
    # Spanish, Portuguese, Italian
    r"código de (?:verificación|verificação|seguridad|segurança|confirmación|confirmação|acceso|acesso)", r"código", r"codice di (?:verifica|sicurezza|accesso|conferma)",
    r"codice otp", r"tu código", r"seu código",
    # Dutch, Scandinavian, Finnish
    r"verificatiecode", r"beveiligingscode", r"inlogcode", r"bevestigingscode", r"verifieringskod", r"engångskod", r"säkerhetskod",
    r"bekræftelseskode", r"sikkerhedskode", r"engangskode", r"bekreftelseskode", r"vahvistuskoodi", r"turvakoodi", r"kertakäyttö",
    # Baltic, Polish, Czech
    r"\bkods\b", r"\bkodas\b", r"\bkode\b", r"\bkod\b", r"\bkoodi\b", r"\bcodice\b", r"\bкод\b", r"コード", r"码", r"碼",
    r"verifikācijas kods", r"apstiprinājuma kods", r"drošības kods", r"vienreizēj", r"patvirtinimo kodas", r"saugos kodas", r"vienkartin",
    r"kod weryfikacyjny", r"kod potwierdzający", r"kod jednorazowy", r"ověřovací kód", r"bezpečnostní kód",
    # Russian, Ukrainian
    r"код подтверждения", r"проверочный код", r"код для входа", r"одноразов", r"код безопасности", r"ваш код", r"код підтвердження",
    # CJK, Turkish, others
    r"验证码", r"驗證碼", r"認証コード", r"確認コード", r"ワンタイム", r"인증번호", r"인증 코드", r"doğrulama kodu", r"güvenlik kodu",
]
KEYWORD_RE = re.compile("|".join(f"(?:{k})" for k in KEYWORDS), re.IGNORECASE)

# Something that looks like a code: 4 to 10 digits, digits split in two groups, or a mixed
# alphanumeric token with at least two digits. Years and long numbers are not excluded here.
TOKEN_RE = re.compile(
    r"(?<![\w.,/:-])(?:\d{4,10}|\d{3,4}[ -]\d{3,4}|(?=[A-Z0-9]*\d[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,10})(?![\w.,/:-]|-\w)"
)

# A code printed right after the phrase that names it may be letters only (Steam Guard style: "QWKZT")
AFTER_KEYWORD_RE = re.compile(r"(?<![\w.,/:-])[A-Z0-9]{4,10}(?![\w.,/:-]|-\w)")
AFTER_KEYWORD_CHARS = 80

YEAR_RE = re.compile(r"(?:19|20)\d\d")

TAG_RE = re.compile(r"<(script|style|head)\b.*?</\1\s*>|<!--.*?-->", re.IGNORECASE | re.DOTALL)
BLOCK_RE = re.compile(r"<\s*(?:br|/p|/div|/tr|/td|/li|/h\d|/table)\b[^>]*>", re.IGNORECASE)
ANY_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"[ \t ​‌‍﻿]+")


def html_to_text(src):
    src = TAG_RE.sub(" ", src)
    src = BLOCK_RE.sub("\n", src)
    src = ANY_TAG_RE.sub(" ", src)
    return html.unescape(src)


def body_text(msg):
    plain, rich = [], []
    for part in msg.walk():
        if part.is_multipart() or part.get_content_disposition() == "attachment":
            continue
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        try:
            content = part.get_content()
        except Exception:
            payload = part.get_payload(decode=True) or b""
            content = payload.decode("utf-8", "replace")
        if not isinstance(content, str):
            continue
        (plain if ctype == "text/plain" else rich).append(content if ctype == "text/plain" else html_to_text(content))
    text = "\n".join(rich) if rich else "\n".join(plain)
    text = SPACE_RE.sub(" ", text)
    return text[:MAX_TEXT_CHARS]


def header(msg, name):
    try:
        value = msg.get(name)
        return str(value) if value is not None else ""
    except Exception:
        return ""


def scan(path):
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        with open(path, "rb") as fh:
            msg = BytesParser(policy=policy.default).parse(fh)
        subject = header(msg, "subject")
        text = body_text(msg)
    except Exception as err:
        return {"path": path, "error": repr(err)[:200]}

    has_otp_header = bool(msg.get("otp-token"))
    subject_hits = {m.group(0).lower() for m in KEYWORD_RE.finditer(subject)}
    score = 0
    near = []
    body_hits = set()
    for m in KEYWORD_RE.finditer(text):
        body_hits.add(m.group(0).lower())
        window = text[max(0, m.start() - 250) : m.end() + 250]
        for t in TOKEN_RE.finditer(window):
            if not YEAR_RE.fullmatch(t.group(0)):
                near.append(t.group(0))
        for t in AFTER_KEYWORD_RE.finditer(text, m.end(), m.end() + AFTER_KEYWORD_CHARS):
            if not YEAR_RE.fullmatch(t.group(0)):
                near.append(t.group(0))
        if len(body_hits) > 20:
            break

    if subject_hits:
        score += 2
    if body_hits:
        score += 1
    if near:
        score += 2
    if TOKEN_RE.search(subject) and (subject_hits or body_hits):
        score += 1
    if has_otp_header:
        score += 5
    if len(text) < 4000:
        score += 1  # code notifications are short

    candidate = has_otp_header or (near and (subject_hits or body_hits))
    return {
        "path": path,
        "candidate": bool(candidate),
        "score": score,
        "subject": subject[:300],
        "from": header(msg, "from")[:200],
        "date": header(msg, "date")[:80],
        "keywords": sorted(subject_hits | body_hits)[:20],
        "tokens": list(dict.fromkeys(near))[:10],
        "otpHeader": has_otp_header,
        "textChars": len(text),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("corpus", help="directory of .eml files")
    ap.add_argument("out", help="output directory")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--negatives", type=int, default=3000, help="size of the random sample of rejected emails")
    ap.add_argument("--limit", type=int, default=0, help="scan only the first N files (for testing)")
    ap.add_argument("--seed", type=int, default=20261110)
    args = ap.parse_args()

    files = sorted(os.path.join(args.corpus, f) for f in os.listdir(args.corpus) if f.endswith(".eml"))
    if args.limit:
        files = files[: args.limit]
    os.makedirs(args.out, exist_ok=True)

    rng = random.Random(args.seed)
    rejected_sample = []  # reservoir sample
    rejected_seen = 0
    counts = {"scanned": 0, "candidates": 0, "errors": 0, "skipped": 0, "otpHeader": 0}

    with open(os.path.join(args.out, "candidates.jsonl"), "w") as cand, open(os.path.join(args.out, "errors.jsonl"), "w") as errs, Pool(args.workers) as pool:
        for i, res in enumerate(pool.imap_unordered(scan, files, chunksize=64), 1):
            counts["scanned"] += 1
            if res is None:
                counts["skipped"] += 1
            elif "error" in res:
                counts["errors"] += 1
                errs.write(json.dumps(res, ensure_ascii=False) + "\n")
            elif res["candidate"]:
                counts["candidates"] += 1
                counts["otpHeader"] += res["otpHeader"]
                cand.write(json.dumps(res, ensure_ascii=False) + "\n")
            else:
                rejected_seen += 1
                if len(rejected_sample) < args.negatives:
                    rejected_sample.append(res)
                else:
                    j = rng.randrange(rejected_seen)
                    if j < args.negatives:
                        rejected_sample[j] = res
            if i % 10000 == 0:
                print(f"{i}/{len(files)} {counts}", file=sys.stderr, flush=True)

    with open(os.path.join(args.out, "rejected-sample.jsonl"), "w") as fh:
        for res in sorted(rejected_sample, key=lambda r: r["path"]):
            fh.write(json.dumps(res, ensure_ascii=False) + "\n")
    with open(os.path.join(args.out, "summary.json"), "w") as fh:
        json.dump(counts, fh, indent=2)
    print(json.dumps(counts), file=sys.stderr)


if __name__ == "__main__":
    main()
