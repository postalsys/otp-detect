# otp-detect

Finds the one-time code (login, verification, two-factor and similar codes) in an email message.

Senders can put the code in an `OTP-Token` header as described in
[draft-goto-otp-token](https://datatracker.ietf.org/doc/draft-goto-otp-token/), and
[postal-mime](https://github.com/postalsys/postal-mime) already exposes that header as `message.otp`.
Most senders do not set it yet, so this package looks for the code in the message body instead, using
a small trained model.

**Status:** early development. There is no published package yet.

## How it works

1. **Header first.** If the message carries a valid `OTP-Token` header, that code wins.
2. **Candidates.** Code-like tokens are extracted from the plain text and the rendered HTML: digit
   runs, grouped digits (`123 456`), and short uppercase or mixed alphanumeric tokens.
3. **Scoring.** A small model scores each candidate from its context: the words around it, its HTML
   styling and position, and message-level signals such as the subject. The best candidate above a
   threshold is returned with its score, or nothing at all.

The model is small enough to ship inside the npm package and runs in plain JavaScript.

## Repository layout

| path        | contents                                                                |
| ----------- | ----------------------------------------------------------------------- |
| `training/` | Python pipeline: corpus prefilter, LLM labeling, feature extraction, training |
| `src/`      | The TypeScript library (to come)                                        |

Training data is derived from private mail and lives in a separate private repository. Nothing in
this repository contains message content.

## License

MIT
