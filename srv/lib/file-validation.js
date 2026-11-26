import { createHash } from 'node:crypto';
import path from 'node:path';
import { FileValidationError } from './errors.js';

/**
 * Supported file types. MIME types are checked against the extension and the
 * content is checked against a signature, so a renamed file is rejected.
 * `application/octet-stream` is accepted for all types because browsers and
 * mail clients often send it; the content signature check still applies.
 */
export const FILE_TYPES = {
    csv: {
        mimeTypes: ['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
        matchesContent: (buf) => !buf.subarray(0, 8192).includes(0), // text, no NUL bytes
    },
    xlsx: {
        mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'],
        matchesContent: (buf) => buf.length >= 4 && buf.readUInt32BE(0) === 0x504b0304, // ZIP "PK\3\4"
    },
    pdf: {
        mimeTypes: ['application/pdf', 'application/octet-stream'],
        matchesContent: (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-',
    },
};

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Returns the lower-case extension without dot ('' if none). */
export function getFileType(fileName) {
    return path.extname(String(fileName ?? '')).slice(1).toLowerCase();
}

/**
 * Decode strict Base64 (whitespace tolerated, optional data-URL prefix stripped).
 * @returns {Buffer}
 */
export function decodeBase64(content) {
    if (typeof content !== 'string' || !content.trim()) {
        throw new FileValidationError('File content is empty.', 'EMPTY_FILE');
    }
    const cleaned = content.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    if (cleaned.length % 4 !== 0 || !BASE64_RE.test(cleaned)) {
        throw new FileValidationError('File content is not valid Base64.', 'INVALID_BASE64');
    }
    return Buffer.from(cleaned, 'base64');
}

/**
 * Validate an uploaded file before it is stored.
 * @param {{fileName:string, mimeType:string, buffer:Buffer, maxFileSize:number}} input
 * @returns {{fileType:string, mimeType:string, size:number, sha256:string}}
 * @throws {FileValidationError}
 */
export function validateFile({ fileName, mimeType, buffer, maxFileSize }) {
    const name = String(fileName ?? '').trim();
    if (!name) throw new FileValidationError('File name is required.', 'MISSING_FILE_NAME');
    if (/[\\/]/.test(name) || name.length > 255) {
        throw new FileValidationError('File name must be a plain name (no path) of at most 255 characters.', 'INVALID_FILE_NAME');
    }

    const fileType = getFileType(name);
    const spec = FILE_TYPES[fileType];
    if (!spec) {
        throw new FileValidationError(
            `Unsupported file type '.${fileType || '?'}'. Supported: ${Object.keys(FILE_TYPES).map((t) => '.' + t).join(', ')}.`,
            'UNSUPPORTED_FILE_TYPE'
        );
    }

    const mime = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (!spec.mimeTypes.includes(mime)) {
        throw new FileValidationError(
            `MIME type '${mimeType}' does not match a .${fileType} file. Expected one of: ${spec.mimeTypes.join(', ')}.`,
            'MIME_TYPE_MISMATCH'
        );
    }

    if (!buffer?.length) throw new FileValidationError('File is empty.', 'EMPTY_FILE');
    if (buffer.length > maxFileSize) {
        throw new FileValidationError(
            `File is ${buffer.length} bytes; the maximum allowed size is ${maxFileSize} bytes.`,
            'FILE_TOO_LARGE'
        );
    }
    if (!spec.matchesContent(buffer)) {
        throw new FileValidationError(`File content is not a valid .${fileType} file.`, 'CONTENT_MISMATCH');
    }

    return {
        fileType,
        mimeType: mime,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
    };
}
