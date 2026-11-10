// Every fixture here is hand written. Never paste real email content into this public repository.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCandidates } from '../src/candidates.js';
import { renderText } from '../src/doc.js';
import { FEATURE_NAMES } from '../src/features.js';
import { decodeEntities, renderHtml } from '../src/html.js';
import { detectOtp, scoreCandidates } from '../src/index.js';
import { MODEL } from '../src/model-data.js';

const codes = (text: string) => extractCandidates(renderText(text)).map(c => c.code);

describe('candidates', () => {
    it('finds digit codes, grouped digits and capital letter codes', () => {
        assert.deepEqual(codes('Your code is 482917'), ['482917']);
        assert.ok(codes('Code: 482 917').includes('482917'));
        assert.ok(codes('Code: 482-917').includes('482917'));
        assert.deepEqual(codes('Steam Guard code: QWKZT'), ['QWKZT']);
        assert.ok(codes('Use 4 8 2 9 1 7 to continue').includes('482917'));
    });

    it('skips prices, times, dates, URLs, addresses and phone numbers', () => {
        assert.deepEqual(codes('Total 1,250.00 EUR at 10:30 on 12.05.2025'), []);
        assert.deepEqual(codes('Visit https://example.com/reset/837261 or mail help1234@example.com'), []);
        assert.deepEqual(codes('Call 372-5-555-0100'), []);
        assert.deepEqual(codes('The 21st meeting, 100mg, 1080p'), []);
    });

    it('keeps long random validation codes', () => {
        assert.deepEqual(codes('validation code: aZ3kQ9mW2xP7rT5v'), ['aZ3kQ9mW2xP7rT5v']);
    });
});

describe('html rendering', () => {
    it('decodes entities', () => {
        assert.equal(decodeEntities('&uuml;hekordne &amp; &#53;&#x36;'), 'ühekordne & 56');
    });

    it('keeps the style of the code and drops hidden content', () => {
        const doc = renderHtml(
            '<html><head><style>p{}</style></head><body><div style="display:none">preheader 111111</div>' +
                '<p>Your verification code:</p><p style="font-size:32px;font-weight:bold;letter-spacing:4px">530 112</p></body></html>'
        );
        assert.ok(!doc.text.includes('p{}'));
        const candidate = extractCandidates(doc).find(c => c.code === '530112');
        assert.ok(candidate);
        const span = doc.spans.find(s => s.start <= candidate.start && s.end >= candidate.end);
        assert.equal(span?.style.fontSize, 32);
        assert.equal(span?.style.bold, true);
        assert.equal(span?.style.letterSpacing, true);
        const hidden = doc.spans.find(s => doc.text.slice(s.start, s.end).includes('111111'));
        assert.equal(hidden?.style.hidden, true);
    });

    it('puts table cells on separate lines', () => {
        const doc = renderHtml('<table><tr><td>1</td><td>2</td></tr></table>');
        assert.equal(doc.text, '1\n2');
    });
});

describe('model', () => {
    it('was trained on the feature list this version computes', () => {
        assert.deepEqual([...MODEL.featureNames], [...FEATURE_NAMES]);
        assert.ok(MODEL.trees.length > 0);
    });
});

describe('detectOtp', () => {
    it('finds the code in a typical HTML login email', () => {
        const result = detectOtp({
            subject: 'Your sign-in code',
            html:
                '<div><p>Hi,</p><p>Use this code to sign in to your Example account:</p>' +
                '<p style="font-size:28px;font-weight:bold;letter-spacing:6px">739104</p>' +
                '<p>The code expires in 10 minutes. If you did not request it, ignore this email.</p>' +
                '<p>Example Inc, 123 Main Street, Springfield 54321</p></div>'
        });
        assert.equal(result?.code, '739104');
    });

    it('finds the code in a plain text email', () => {
        const result = detectOtp({
            subject: 'Verify your email',
            text: 'Hello,\n\nYour verification code is: 284716\n\nIt is valid for 15 minutes. Do not share it with anyone.\n\nThanks,\nThe Example team\n'
        });
        assert.equal(result?.code, '284716');
    });

    it('finds the code in an Estonian email', () => {
        const result = detectOtp({
            subject: 'Sinu kinnituskood',
            text: 'Tere!\n\nSinu ühekordne kinnituskood on 913560\n\nKood kehtib 10 minutit.\n'
        });
        assert.equal(result?.code, '913560');
    });

    it('stays quiet on an order confirmation', () => {
        const result = detectOtp({
            subject: 'Order 58213490 confirmed',
            text: 'Thank you for your order 58213490.\nTotal: 49.90 EUR\nTracking number: 77341209\nCustomer service: +372 555 0100\n'
        });
        assert.equal(result, null);
    });

    it('stays quiet on a promotional email', () => {
        const result = detectOtp({
            subject: 'Save 20% this weekend',
            html: '<p>Get 20% off your next purchase with promo code <b>SPRING24</b> at checkout. Offer valid until Sunday.</p>'
        });
        assert.equal(result, null);
    });

    it('stays fast on hostile input', () => {
        const big = 400 * 1024;
        const inputs = [
            { html: '<a'.repeat(big / 2) },
            { html: '<!'.repeat(big / 2) },
            { html: '<a x="' + 'y'.repeat(big) },
            { text: 'a('.repeat(big / 2) },
            { text: 'AB12 '.repeat(big / 5) },
            { html: '<div>'.repeat(big / 5) + 'code 123456' }
        ];
        for (const input of inputs) {
            const started = Date.now();
            scoreCandidates(input);
            const elapsed = Date.now() - started;
            assert.ok(elapsed < 3000, `took ${elapsed} ms on ${JSON.stringify(input).slice(0, 40)}`);
        }
    });

    it('returns nothing for an empty message', () => {
        assert.equal(detectOtp({}), null);
        assert.deepEqual(scoreCandidates({ subject: 'Hello' }), []);
    });
});
