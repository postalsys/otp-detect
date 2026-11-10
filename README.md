# otp-detect

Finds the one-time code (login, verification, two-factor and similar codes) in an email message.

Senders can put the code in an `OTP-Token` header as described in
[draft-goto-otp-token](https://datatracker.ietf.org/doc/draft-goto-otp-token/), and
[postal-mime](https://github.com/postalsys/postal-mime) already exposes that header as `message.otp`.
Most senders do not set it yet, so this package looks for the code in the message body instead, using
a small trained model.

**Status:** early development, not published yet.

## Usage

```js
import { detectOtp } from '@postalsys/otp-detect';

const result = detectOtp({ subject, text, html });
// { code: '739104', raw: '739 104', score: 0.98, source: 'html' } or null
```

The input is an already parsed message: `subject`, the `text/plain` body and the `text/html` body,
any of them optional. With [postal-mime](https://github.com/postalsys/postal-mime):

```js
const email = await PostalMime.parse(raw);
const code = email.otp?.code ?? detectOtp(email)?.code;
```

Prefer the `OTP-Token` header when there is one. Neither the header nor the body is authenticated:
check that the message passes DKIM for the sender's domain before offering a code to a user.

`scoreCandidates(input)` returns every code-like token with its score, best first, for debugging or
custom rules. Both functions take `{ threshold }` to override the default threshold (0.9).

## How it works

1. **Rendering.** The HTML body is rendered to text while remembering how each piece of text looks:
   font size, bold, letter spacing, links, hidden preheaders, quoted reply history.
2. **Candidates.** Code-like tokens are extracted from the rendered HTML and the plain text: digit
   runs, grouped digits (`123 456`), capital letter codes (`QWKZT`), mixed alphanumeric codes.
3. **Scoring.** Gradient boosted trees score each candidate from its context: the distance to words
   that name a code in many languages, to words that name order numbers, prices and promo codes,
   its styling and position, and message-level signals such as the subject. The best candidate above
   the threshold is returned, or nothing.

The model is a few dozen kilobytes of trees embedded in the package, and runs in plain JavaScript with
no runtime dependencies. Work is linear in the size of the message, which is cut at 512 KB per body.

## Accuracy

Measured with cross-validation grouped by sender domain, so every score is for senders the model never
saw in training, averaged over three shuffles, at the default threshold:

| emails                                                         | result                          |
| -------------------------------------------------------------- | ------------------------------- |
| 324 emails with a one-time code                                | 67.5% correct, 3% wrong code    |
| 2,045 random emails                                            | 0.06% answered (false positive) |
| 8,862 hard negatives (order numbers, promo codes, magic links) | 1.3% answered (false positive)  |

The training data is mostly English and Estonian. Other languages rely on the keyword lists alone.

## Repository layout

| path        | contents                                                                        |
| ----------- | ------------------------------------------------------------------------------- |
| `src/`      | The library: HTML rendering, candidates, keywords, features, tree evaluation    |
| `scripts/`  | Feature dump for training and a corpus scanner (`dump-features`, `scan-corpus`) |
| `training/` | Python pipeline: corpus prefilter, LLM labeling, email selection, training      |

Training data is derived from private mail and lives in a separate private repository. Nothing in
this repository contains message content; test fixtures are written by hand.

## License

MIT
