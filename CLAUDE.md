# otp-detect

Detects the one-time code (OTP) in an email: login, verification, two-factor, password reset and
transaction approval codes. Public repository, published as `@postalsys/otp-detect` once the
library exists.

## Rules

- Never use emojis in code, comments, or documentation.
- Never use em or en dashes in anything written here.
- Use Conventional Commit format for commit messages.
- **This repository is public. Never commit message content**: no `.eml` files, no labels, no
  subjects, sender addresses or extracted codes from the corpus, not even in tests, fixtures, docs
  or commit messages. Test fixtures are hand-written synthetic emails. `.gitignore` blocks `*.eml`
  and `*.jsonl` as a backstop, not as the only guard.

## Two repositories

| repo                       | visibility | contents                                                       |
| -------------------------- | ---------- | -------------------------------------------------------------- |
| `postalsys/otp-detect`     | public     | library, training code, labeling prompt                        |
| `postalsys/otp-data`       | private    | OTP email subset, LLM labels, prefilter output, training sets |

The repos are checked out side by side (`~/Projects/otp-detect`, `~/Projects/otp-data`). Training
scripts take data paths as arguments and never hardcode the private repo.

The raw corpus is `~/Data/EmailCorpus/gmail-eml` (about 320k `.eml` files, personal mail). It is
read-only input; the selected emails are copied into `otp-data`.

## Pipeline (`training/`)

Standard library Python, run with `python3 -I`.

1. `prefilter.py <corpus> <out>`: recall-oriented scan of the whole corpus (about a minute on 16
   cores). Writes `candidates.jsonl` and a random `rejected-sample.jsonl` used to measure recall.
   Keep it loose: the LLM decides, the filter only shrinks the set.
2. `label.py <in.jsonl> <out.jsonl> --model ...`: LLM labeling through the OpenAI Responses API
   with a strict JSON schema. Resumable. Returns `kind` (`otp`, `magic_link`, `other`) and the
   exact codes; each code is checked to occur verbatim in the text (`verified`).
   Key from `OPENAI_API_KEY` (stored in `otp-data/.env`, never here).
   Labeling runs in two passes: a cheap model over everything, then a stronger model over the
   non-`other` rows plus a random sample of `other` rows to measure disagreement.
3. `select_emails.py <labels> <out>`: merges the passes (pass 2 wins) into `final.jsonl` and copies
   the emails into `otp/`, `hard-negative/` and `random-negative/` in the private repo.

## Model design

Candidates plus a scorer, chosen over a token-tagging transformer to stay small and explainable:

- Candidate extraction is deterministic (regex over canonical plain text and rendered HTML).
- A small learned model scores each candidate from context features: nearby keywords in many
  languages, distance to them, HTML emphasis (font size, bold, letter spacing, isolated block),
  token shape, subject signals.
- The library returns the best candidate above a threshold, or nothing. A missed code is cheaper
  than a wrong one: a wrong code shown to a user as "your login code" is the worst outcome.

## OTP-Token header

`draft-goto-otp-token` defines an `OTP-Token` header (structured field String with an `origin`
parameter). postal-mime parses it in `src/otp-token.ts` and exposes `message.otp = { code, origin }`.
Header first, body detection as the fallback. Do not reimplement the header parser here.
