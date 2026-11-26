import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateFile, decodeBase64 } from '../../srv/lib/file-validation.js';
import { FileValidationError } from '../../srv/lib/errors.js';

const fixture = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url));
const MAX = 1024 * 1024;
const csvBuf = Buffer.from('CustomerPO\n1\n');
const check = (args) => validateFile({ maxFileSize: MAX, ...args });
const rejectsWith = (code, args) =>
    assert.throws(() => check(args), (e) => e instanceof FileValidationError && e.code === code && e.status === 400);

describe('File validation', () => {
    test('accepts CSV, XLSX and PDF with matching MIME type and content', () => {
        assert.equal(check({ fileName: 'po.csv', mimeType: 'text/csv', buffer: csvBuf }).fileType, 'csv');
        assert.equal(check({ fileName: 'PO.XLSX', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: fixture('sample-po.xlsx') }).fileType, 'xlsx');
        const pdf = check({ fileName: 'po.pdf', mimeType: 'application/pdf', buffer: fixture('sample-po.pdf') });
        assert.equal(pdf.fileType, 'pdf');
        assert.match(pdf.sha256, /^[0-9a-f]{64}$/);
    });

    test('accepts charset parameters and application/octet-stream', () => {
        assert.equal(check({ fileName: 'po.csv', mimeType: 'text/csv; charset=utf-8', buffer: csvBuf }).mimeType, 'text/csv');
        check({ fileName: 'po.pdf', mimeType: 'application/octet-stream', buffer: fixture('sample-po.pdf') });
    });

    test('rejects unsupported extensions', () => {
        rejectsWith('UNSUPPORTED_FILE_TYPE', { fileName: 'po.docx', mimeType: 'application/octet-stream', buffer: csvBuf });
        rejectsWith('UNSUPPORTED_FILE_TYPE', { fileName: 'po.xls', mimeType: 'application/vnd.ms-excel', buffer: csvBuf });
        rejectsWith('UNSUPPORTED_FILE_TYPE', { fileName: 'noextension', mimeType: 'text/csv', buffer: csvBuf });
    });

    test('rejects MIME type mismatches', () => {
        rejectsWith('MIME_TYPE_MISMATCH', { fileName: 'po.pdf', mimeType: 'text/csv', buffer: fixture('sample-po.pdf') });
        rejectsWith('MIME_TYPE_MISMATCH', { fileName: 'po.csv', mimeType: 'image/png', buffer: csvBuf });
    });

    test('rejects content that does not match the extension', () => {
        rejectsWith('CONTENT_MISMATCH', { fileName: 'po.pdf', mimeType: 'application/pdf', buffer: csvBuf });
        rejectsWith('CONTENT_MISMATCH', { fileName: 'po.xlsx', mimeType: 'application/octet-stream', buffer: csvBuf });
        rejectsWith('CONTENT_MISMATCH', { fileName: 'po.csv', mimeType: 'text/csv', buffer: fixture('sample-po.xlsx') });
    });

    test('rejects empty and oversized files', () => {
        rejectsWith('EMPTY_FILE', { fileName: 'po.csv', mimeType: 'text/csv', buffer: Buffer.alloc(0) });
        rejectsWith('FILE_TOO_LARGE', { fileName: 'po.csv', mimeType: 'text/csv', buffer: Buffer.alloc(MAX + 1, 0x41) });
    });

    test('rejects missing or path-like file names', () => {
        rejectsWith('MISSING_FILE_NAME', { fileName: ' ', mimeType: 'text/csv', buffer: csvBuf });
        rejectsWith('INVALID_FILE_NAME', { fileName: '../../etc/po.csv', mimeType: 'text/csv', buffer: csvBuf });
        rejectsWith('INVALID_FILE_NAME', { fileName: 'C:\\temp\\po.csv', mimeType: 'text/csv', buffer: csvBuf });
    });

    test('decodes strict Base64 (data-URL prefix and line breaks tolerated)', () => {
        assert.equal(decodeBase64('aGVs\nbG8=').toString(), 'hello');
        assert.equal(decodeBase64('data:text/csv;base64,aGVsbG8=').toString(), 'hello');
        assert.throws(() => decodeBase64('not base64!'), { code: 'INVALID_BASE64' });
        assert.throws(() => decodeBase64('abc'), { code: 'INVALID_BASE64' });
        assert.throws(() => decodeBase64(''), { code: 'EMPTY_FILE' });
    });
});
