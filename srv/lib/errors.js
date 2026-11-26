/**
 * Error raised when an uploaded file is rejected before it is stored
 * (unsupported type, too large, corrupt Base64, ...). Maps to HTTP 400.
 */
export class FileValidationError extends Error {
    constructor(message, code = 'INVALID_FILE') {
        super(message);
        this.name = 'FileValidationError';
        this.code = code;
        this.status = 400;
    }
}

/**
 * Error raised by an extractor when a stored file cannot be converted into
 * the common PO structure. `details` lists every problem found
 * ({ message, lineNumber?, field? }) so users can fix the file in one go.
 */
export class ExtractionError extends Error {
    constructor(message, details = [], code = 'EXTRACTION_FAILED') {
        super(message);
        this.name = 'ExtractionError';
        this.code = code;
        this.details = details;
    }
}

/** Raised when an extractor exists but its backing service is not configured. */
export class ExtractionNotConfiguredError extends ExtractionError {
    constructor(message) {
        super(message, [], 'EXTRACTION_NOT_CONFIGURED');
        this.name = 'ExtractionNotConfiguredError';
    }
}
