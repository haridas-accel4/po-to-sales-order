import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    compileKeywords, findKeyword, htmlToText, parseMessage, selectAttachments, classifyMessage, safeFileName,
} from '../../srv/lib/gmail/email-filter.js';

const KEYWORDS = ['Purchase Order', 'PO', 'Sales Order', 'SO'];
const EXT = ['pdf', 'xlsx', 'csv'];
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('keyword matching', () => {
    const k = compileKeywords(KEYWORDS);

    test('matches subject or body text', () => {
        assert.equal(findKeyword(['New Purchase Order', ''], k), 'Purchase Order');
        assert.equal(findKeyword(['Hello', 'please find our sales order attached'], k), 'Sales Order');
    });

    test('is case-insensitive and tolerates extra whitespace / plural', () => {
        assert.equal(findKeyword(['purchase ORDER'], k), 'Purchase Order');
        assert.equal(findKeyword(['Purchase\n  Orders for May'], k), 'Purchase Order');
        assert.equal(findKeyword(['po 4711'], k), 'PO');
        assert.equal(findKeyword(['Two POs attached'], k), 'PO');
    });

    test('PO and SO match only as standalone words', () => {
        for (const text of ['PO', 'PO#4711', 'PO-2027-0001', 'PO4500012345', '(PO)', 'our PO: 12', 'SO 9001']) {
            assert.ok(findKeyword([text], k), `should match: ${text}`);
        }
        for (const text of ['report', 'photo', 'POST', 'expose', 'Sonic', 'also', 'reason', 'TPO', 'ISO 9001', 'Polish']) {
            assert.equal(findKeyword([text], k), null, `should not match: ${text}`);
        }
    });

    test('unrelated text does not match', () => {
        assert.equal(findKeyword(['Lunch on Friday?', 'See you at the office.'], k), null);
        assert.equal(findKeyword([], k), null);
    });

    test('keywords are configurable, incl. case-sensitive abbreviations', () => {
        const custom = compileKeywords(['Bestellung', { term: 'SO', caseSensitive: true }]);
        assert.equal(findKeyword(['Neue Bestellung'], custom), 'Bestellung');
        assert.equal(findKeyword(['SO 12'], custom), 'SO');
        assert.equal(findKeyword(['so we agreed'], custom), null);
        assert.equal(findKeyword(['Purchase Order'], custom), null);
    });

    test('regex special characters in keywords are literal', () => {
        const custom = compileKeywords(['P.O.', 'Order (new)']);
        assert.equal(findKeyword(['P.O. 77'], custom), 'P.O.');
        assert.equal(findKeyword(['PxOx 77'], custom), null);
        assert.equal(findKeyword(['Order (new) attached'], custom), 'Order (new)');
    });
});

describe('HTML bodies', () => {
    test('strips tags, scripts, styles, comments and decodes entities', () => {
        const text = htmlToText('<html><head><title>PO</title><style>.PO{}</style></head><body><script>var SO=1</script>' +
            '<!-- Sales Order --><p>Attached:&nbsp;purchase&#32;order&amp;more</p></body></html>');
        assert.equal(text, 'Attached: purchase order&more');
    });

    test('keywords hidden in markup only do not match', () => {
        const k = compileKeywords(KEYWORDS);
        const text = htmlToText('<div class="PO" data-so="1" title="Sales Order">Hello</div>');
        assert.equal(findKeyword([text], k), null);
    });
});

describe('message parsing and attachment selection', () => {
    const message = {
        id: 'm1', threadId: 't1', internalDate: String(Date.UTC(2027, 0, 15, 10)),
        payload: {
            mimeType: 'multipart/mixed',
            headers: [{ name: 'From', value: 'Buyer <b@x.example>' }, { name: 'subject', value: 'Order' }],
            parts: [
                { partId: '0', mimeType: 'multipart/alternative', parts: [
                    { partId: '0.0', mimeType: 'text/plain', body: { data: b64url('plain PO text') } },
                    { partId: '0.1', mimeType: 'text/html', body: { data: b64url('<p>html <b>SO</b></p>') } },
                ] },
                { partId: '1', mimeType: 'application/pdf', filename: 'po.PDF', body: { attachmentId: 'a1', size: 10 } },
                { partId: '2', mimeType: 'image/png', filename: 'logo.png', headers: [{ name: 'Content-Disposition', value: 'inline' }, { name: 'Content-ID', value: '<x>' }], body: { attachmentId: 'a2', size: 5 } },
                { partId: '3', mimeType: 'application/octet-stream', filename: 'order.xlsx', body: { attachmentId: 'a3', size: 20 } },
                { partId: '4', mimeType: 'text/csv', filename: 'items.csv', body: { data: b64url('a,b'), size: 3 } },
                { partId: '5', mimeType: 'application/zip', filename: 'all.zip', body: { attachmentId: 'a5', size: 50 } },
            ],
        },
    };

    test('parseMessage extracts header data, bodies and attachments', () => {
        const p = parseMessage(message);
        assert.equal(p.sender, 'Buyer <b@x.example>');
        assert.equal(p.subject, 'Order');
        assert.equal(p.receivedAt, '2027-01-15T10:00:00.000Z');
        assert.equal(p.plainText, 'plain PO text');
        assert.equal(p.htmlText, 'html SO');
        assert.deepEqual(p.attachments.map((a) => a.partId), ['1', '2', '3', '4', '5']);
        assert.equal(p.attachments[1].inline, true);
    });

    test('only .pdf/.xlsx/.csv are supported; inline images and other files are ignored', () => {
        const { supported, ignored } = selectAttachments(parseMessage(message).attachments, EXT);
        assert.deepEqual(supported.map((a) => a.fileName), ['po.PDF', 'order.xlsx', 'items.csv']);
        assert.deepEqual(ignored.map((a) => [a.fileName, a.reason]), [['logo.png', 'inline content'], ['all.zip', 'unsupported type .zip']]);
    });

    test('classifyMessage requires a keyword and a supported attachment', () => {
        const p = parseMessage(message);
        assert.equal(classifyMessage(p, { keywords: KEYWORDS, extensions: EXT }).process, true);
        const noKeyword = { ...p, subject: 'Hello', plainText: 'nothing', htmlText: '' };
        assert.match(classifyMessage(noKeyword, { keywords: KEYWORDS, extensions: EXT }).reason, /keyword/);
        const noAttachment = { ...p, attachments: p.attachments.filter((a) => a.fileName.endsWith('.zip')) };
        assert.match(classifyMessage(noAttachment, { keywords: KEYWORDS, extensions: EXT }).reason, /supported attachment/);
    });

    test('safeFileName removes path separators and keeps the extension when shortening', () => {
        assert.equal(safeFileName('../../etc/po.csv'), '.._.._etc_po.csv');
        const long = safeFileName(`${'x'.repeat(300)}.xlsx`);
        assert.equal(long.length, 255);
        assert.ok(long.endsWith('.xlsx'));
    });
});
