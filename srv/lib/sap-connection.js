import cds from '@sap/cds';
import { SAP_SERVICE, connectSalesOrderApi, describeSapError } from './sap-sales-order.js';

const LOG = cds.log('po2so');

/**
 * Connection to the SAP S/4HANA Cloud Sales Order API (API_SALES_ORDER_SRV, OData V2).
 *
 * Three modes:
 *   - remote      S4_SALES_ORDER_API_URL (+ S4_USER / S4_PASSWORD) set in .env: the app
 *                 calls that tenant directly with basic authentication (local / hybrid runs)
 *   - destination production profile: BTP destination S4HC_SALES (package.json)
 *   - mock        nothing configured: CAP serves srv/external/API_SALES_ORDER_SRV.js locally
 */

/**
 * Point API_SALES_ORDER_SRV at the tenant from the environment. Must run before CAP
 * serves or connects to the service (server.js calls it at load time), otherwise the
 * local mock is used.
 * @returns {boolean} true if remote credentials were applied
 */
export function applySapCredentialsFromEnv(env = process.env) {
    const url = env.S4_SALES_ORDER_API_URL?.trim();
    if (!url) return false;
    const requires = cds.env.requires[SAP_SERVICE];
    if (!requires) throw new Error(`cds.requires.${SAP_SERVICE} is not configured in package.json.`);
    requires.credentials = {
        url: url.replace(/\/+$/, ''),
        ...(env.S4_USER ? { username: env.S4_USER, password: env.S4_PASSWORD ?? '' } : {}),
    };
    return true;
}

/** Which kind of SAP connection the app is configured for (no network call). */
export function sapConnectionInfo() {
    const credentials = cds.env.requires[SAP_SERVICE]?.credentials ?? {};
    if (credentials.url) return { mode: 'remote', target: credentials.url, user: credentials.username ?? null };
    if (credentials.destination) return { mode: 'destination', target: credentials.destination, user: null };
    return { mode: 'mock', target: 'local mock (srv/external/API_SALES_ORDER_SRV.js)', user: null };
}

/**
 * Check that the Sales Order API answers: reads one sales order number.
 * Never throws; the result says whether SAP was reachable and why not.
 */
export async function checkSapConnection() {
    const info = sapConnectionInfo();
    const checkedAt = new Date().toISOString();
    const started = Date.now();
    try {
        const s4 = await connectSalesOrderApi();
        const { A_SalesOrder } = s4.entities;
        await s4.run(SELECT.one.from(A_SalesOrder).columns('SalesOrder'));
        return {
            ...info, connected: true, checkedAt, responseTimeMs: Date.now() - started,
            message: info.mode === 'mock'
                ? 'Using the local mock Sales Order API (no SAP system configured).'
                : `Connected to the SAP Sales Order API at ${info.target}.`,
        };
    } catch (e) {
        const { httpStatus, messages } = describeSapError(e);
        const reason = httpStatus === 401 ? 'user or password rejected (HTTP 401)'
            : httpStatus === 403 ? 'user has no authorization for the Sales Order API (HTTP 403)'
            : `${httpStatus ? `HTTP ${httpStatus}: ` : ''}${messages.join(' ')}`;
        return {
            ...info, connected: false, checkedAt, responseTimeMs: Date.now() - started,
            message: `Cannot reach the SAP Sales Order API at ${info.target}: ${reason}`,
        };
    }
}

/** Log the SAP connection result once at server start. */
export async function logSapConnection() {
    const status = await checkSapConnection();
    if (status.connected) LOG.info(status.message);
    else LOG.error(status.message);
    return status;
}
