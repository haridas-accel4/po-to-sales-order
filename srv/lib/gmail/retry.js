const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** HTTP status of a googleapis (gaxios) error, if any. */
export function httpStatusOf(error) {
    const status = error?.response?.status ?? error?.status ?? error?.code;
    return typeof status === 'number' ? status : (Number.isInteger(Number(status)) ? Number(status) : null);
}

/** Network errors, rate limiting and server errors are worth retrying. */
export function isTransient(error) {
    if (!error) return false;
    if (TRANSIENT_CODES.has(error.code) || TRANSIENT_CODES.has(error.cause?.code)) return true;
    const status = httpStatusOf(error);
    if (status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(JSON.stringify(error.response?.data ?? error.errors ?? ''))) return true;
    return status !== null && TRANSIENT_STATUS.has(status);
}

/** The stored authorization is no longer valid (revoked, expired, wrong client). */
export function isAuthError(error) {
    const status = httpStatusOf(error);
    return status === 401 || /invalid_grant|invalid_client|unauthorized_client/i.test(`${error?.message ?? ''} ${JSON.stringify(error?.response?.data ?? '')}`);
}

/** Call fn, retrying transient failures with exponential backoff. */
export async function withRetry(fn, { retries = 3, baseDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (attempt >= retries || !isTransient(e)) throw e;
            await sleep(baseDelayMs * 2 ** attempt);
        }
    }
}

/** Error text safe for logs and the status screen (no tokens, no request details). */
export function safeErrorMessage(error) {
    const status = httpStatusOf(error);
    const apiMessage = error?.response?.data?.error?.message ?? error?.response?.data?.error_description ?? error?.response?.data?.error;
    const text = typeof apiMessage === 'string' ? apiMessage : (error?.message ?? String(error));
    return `${status ? `HTTP ${status}: ` : ''}${text}`.replace(/(access_token|refresh_token|client_secret|code)=[^&\s]+/gi, '$1=***').slice(0, 1000);
}
