import cds from '@sap/cds';
import { FileValidationError } from './lib/errors.js';
import { decodeBase64 } from './lib/file-validation.js';
import { invalidDates, protectedFieldsIn, PROTECTED_ORDER_FIELDS, PROTECTED_ITEM_FIELDS } from './lib/input-validation.js';
import { ingestDocument, processInboundOrder, validateInboundOrder, postSalesOrder, FINAL_STATUSES } from './lib/pipeline.js';
import { MAPPING_RULES, trimTextFields, missingRequired, sameKey, conflictMessage } from './lib/mapping-validation.js';
import * as gmail from './lib/gmail/index.js';
import { checkSapConnection } from './lib/sap-connection.js';

/** Orders that are no longer open for revalidation (REJECTED is reserved for exception closing). */
const CLOSED_STATUSES = ['CREATED', 'REJECTED'];

export default class SalesOrderService extends cds.ApplicationService {
    init() {
        const { InboundOrders, InboundItems } = this.entities;

        // ------------------------------------------------------------ upload
        this.on('uploadPurchaseOrder', async (req) => {
            const { fileName, mimeType, content, customerId } = req.data;
            try {
                const buffer = decodeBase64(content);
                return await ingestDocument({ source: 'UPLOAD', fileName, mimeType, buffer, customerId });
            } catch (e) {
                if (e instanceof FileValidationError) return req.reject({ status: 400, code: e.code, message: e.message });
                throw e;
            }
        });

        // ------------------------------------------------------------ bound actions
        const loadOrder = async (req) => {
            const ID = req.params[0]?.ID ?? req.params[0];
            const order = await SELECT.one.from(InboundOrders, ID).columns('ID', 'status', 'extractionMethod');
            if (!order) return req.reject(404, `Inbound order ${ID} not found.`);
            if (FINAL_STATUSES.includes(order.status)) {
                return req.reject(409, `Inbound order ${ID} has status ${order.status} and can no longer be changed.`);
            }
            return order;
        };

        this.on('revalidate', InboundOrders, async (req) => {
            const order = await loadOrder(req);
            if (!order) return;
            if (!order.extractionMethod) {
                return req.reject(409, 'This order was never extracted successfully; fix the cause and call reprocess() instead.');
            }
            await validateInboundOrder(order.ID);
            return SELECT.one.from(InboundOrders, order.ID);
        });

        this.on('resubmit', InboundOrders, async (req) => {
            const order = await loadOrder(req);
            if (!order) return;
            if (!order.extractionMethod) {
                return req.reject(409, 'This order was never extracted successfully; fix the cause and call reprocess() instead.');
            }
            await validateInboundOrder(order.ID);
            await postSalesOrder(order.ID);
            return SELECT.one.from(InboundOrders, order.ID);
        });

        this.on('reprocess', InboundOrders, async (req) => {
            const order = await loadOrder(req);
            if (!order) return;
            await processInboundOrder(order.ID);
            return SELECT.one.from(InboundOrders, order.ID);
        });

        // ------------------------------------------------------------ bulk revalidation
        this.on('revalidateOpenOrders', () => this._revalidateOpenOrders());

        // ------------------------------------------------------------ review / corrections
        // Inbound orders are only created through the intake pipeline.
        this.before('CREATE', InboundOrders, (req) =>
            req.reject(405, 'Inbound orders cannot be created directly; use uploadPurchaseOrder.'));

        // No changes once a Sales Order was created. Orders are never deleted: deleting
        // would cascade to the original file and the append-only event log.
        this.before(['UPDATE', 'DELETE'], InboundOrders, async (req) => {
            const order = await SELECT.one.from(InboundOrders, req.data.ID ?? req.params[0]?.ID ?? req.params[0]).columns('status');
            if (order && FINAL_STATUSES.includes(order.status)) return req.reject(409, `Inbound order has status ${order.status} and can no longer be changed.`);
            if (req.event === 'DELETE') {
                return req.reject(405, 'Inbound orders cannot be deleted; the original file and processing history must be preserved.');
            }
        });

        // CAP's Date type only checks the format; reject impossible calendar dates.
        this.before('UPDATE', InboundOrders, (req) => {
            for (const { field, message } of invalidDates(req.data)) {
                req.error({ status: 400, code: 'INVALID_DATE', message, target: field });
            }
        });

        this.before(['CREATE', 'UPDATE', 'DELETE'], InboundItems, async (req) => {
            const parentId = await parentOf(req);
            const order = parentId && await SELECT.one.from(InboundOrders, parentId).columns('status');
            if (order && FINAL_STATUSES.includes(order.status)) req.reject(409, `Inbound order has status ${order.status} and can no longer be changed.`);
            req._po2soParent = parentId;
        });

        this.before(['CREATE', 'UPDATE'], InboundItems, (req) => {
            for (const { field, message } of invalidDates(req.data, ['requestedDeliveryDate'])) {
                req.error({ status: 400, code: 'INVALID_DATE', message, target: field });
            }
        });

        // Any correction re-runs mapping + validation so the status never goes stale.
        this.after('UPDATE', InboundOrders, async (_, req) => {
            const ID = req.data.ID ?? req.params[0]?.ID ?? req.params[0];
            const order = await SELECT.one.from(InboundOrders, ID).columns('extractionMethod');
            if (order?.extractionMethod) await validateInboundOrder(ID);
        });
        this.after(['CREATE', 'UPDATE', 'DELETE'], InboundItems, async (_, req) => {
            if (req._po2soParent) await validateInboundOrder(req._po2soParent);
        });

        this._registerMappingHandlers();
        this._registerGmailHandlers();
        this.on('sapStatus', () => checkSapConnection());

        return super.init();
    }

    // ---------------------------------------------------------------- Gmail intake

    /** Gmail status / manual check / disconnect. OAuth itself runs on /auth/gmail (server.js). */
    _registerGmailHandlers() {
        this.on('gmailStatus', () => gmail.getStatus());

        this.on('checkGmailNow', async (req) => {
            const { backfillDays } = req.data;
            if (backfillDays !== null && backfillDays !== undefined && !(Number.isInteger(backfillDays) && backfillDays >= 1 && backfillDays <= 90)) {
                return req.reject({ status: 400, code: 'INVALID_BACKFILL', target: 'backfillDays', message: 'backfillDays must be a whole number from 1 to 90.' });
            }
            // No database access in this request: the sync runs detached and commits
            // each attachment in its own transaction.
            if (!gmail.isConnected()) {
                return req.reject({ status: 409, code: 'GMAIL_NOT_CONNECTED', message: 'Gmail is not connected. Connect a Gmail account first.' });
            }
            try {
                return await gmail.runSync({ backfillDays: backfillDays ?? null });
            } catch (e) {
                return req.reject({ status: e.status ?? 502, code: e.code ?? 'GMAIL_SYNC_FAILED', message: e.message });
            }
        });

        this.on('disconnectGmail', async () => {
            await gmail.disconnect();
            return gmail.getStatus();
        });
    }

    // ---------------------------------------------------------------- mapping master data

    /**
     * Customers, MaterialMappings and UomMappings drive customer / material / UoM
     * mapping in the intake pipeline. Validate them so mapping stays unambiguous.
     */
    _registerMappingHandlers() {
        const { Customers, MaterialMappings, UomMappings, InboundOrders } = this.entities;
        const entities = { Customers, MaterialMappings, UomMappings };

        for (const [name, entity] of Object.entries(entities)) {
            const rule = MAPPING_RULES[name];

            this.before(['CREATE', 'UPDATE'], entity, async (req) => {
                trimTextFields(req.data, rule.text);

                // PUT/PATCH on a key that does not exist creates the row (upsert) -> treat as create
                let isInsert = req.event === 'CREATE';
                if (!isInsert) {
                    const keys = Object.fromEntries(rule.keys.map((k) => [k, req.data[k]]));
                    isInsert = !(await SELECT.one.from(entity).columns(rule.keys[0]).where(keys));
                }
                const full = isInsert || req.method === 'PUT';

                const missing = missingRequired(req.data, rule.required, { full });
                if (missing.length) {
                    for (const m of missing) req.error({ status: 400, code: 'MAPPING_REQUIRED_FIELD', message: m.message, target: m.field });
                    return;
                }
                if (!isInsert) {
                    // keys cannot change on update; a new sold-to party must not orphan material mappings
                    if (name === 'Customers' && Object.hasOwn(req.data, 'soldToParty')) await this._rejectOrphaningSoldToChange(req, Customers, MaterialMappings);
                    return;
                }

                await this._rejectConflictingKey(req, entity, rule);
                if (name === 'MaterialMappings') await this._rejectUnknownSoldTo(req, Customers);
            });
        }

        // A customer referenced by inbound orders, or the only customer behind material
        // mappings, must stay (it can be deactivated instead).
        this.before('DELETE', Customers, async (req) => {
            const customerId = req.data.customerId ?? req.params[0]?.customerId ?? req.params[0];
            const { count } = await SELECT.one.from(InboundOrders).columns('count(1) as count').where({ customerId });
            if (count > 0) {
                return req.reject({
                    status: 409,
                    code: 'CUSTOMER_IN_USE',
                    target: 'customerId',
                    message: `Customer '${customerId}' is referenced by ${count} inbound order(s) and cannot be deleted. ` +
                        'Set active = false to stop using it for new purchase orders.',
                });
            }
            const customer = await SELECT.one.from(Customers).columns('soldToParty').where({ customerId });
            const orphans = customer && await this._orphanedMappingCount(Customers, MaterialMappings, customer.soldToParty, customerId);
            if (orphans > 0) {
                return req.reject({
                    status: 409,
                    code: 'CUSTOMER_IN_USE',
                    target: 'customerId',
                    message: `Customer '${customerId}' is the only customer with sold-to party ${customer.soldToParty}, which is used by ` +
                        `${orphans} material mapping(s). It cannot be deleted; set active = false instead.`,
                });
            }
        });

        // Safety net (e.g. concurrent inserts): a unique-key violation is a conflict, not a server error.
        this.on('error', (err) => {
            if (/UNIQUE constraint failed/i.test(err.message ?? '')) {
                err.status = 409;
                err.code = 'ENTITY_ALREADY_EXISTS';
                err.message = `An entry with the same key already exists (${err.message.replace(/^.*UNIQUE constraint failed:\s*/i, '')}).`;
            }
        });
    }

    /** Material mappings of a sold-to party that no other customer than `customerId` carries. */
    async _orphanedMappingCount(Customers, MaterialMappings, soldToParty, customerId) {
        if (!soldToParty) return 0;
        const others = await SELECT.one.from(Customers).columns('customerId').where({ soldToParty, customerId: { '!=': customerId } });
        if (others) return 0;
        const { count } = await SELECT.one.from(MaterialMappings).columns('count(1) as count').where({ soldToParty });
        return count;
    }

    async _rejectOrphaningSoldToChange(req, Customers, MaterialMappings) {
        const { customerId, soldToParty } = req.data;
        const current = await SELECT.one.from(Customers).columns('soldToParty').where({ customerId });
        if (!current || current.soldToParty === soldToParty) return;
        const orphans = await this._orphanedMappingCount(Customers, MaterialMappings, current.soldToParty, customerId);
        if (orphans > 0) {
            return req.reject({
                status: 409,
                code: 'CUSTOMER_IN_USE',
                target: 'soldToParty',
                message: `Sold-to party cannot change from ${current.soldToParty} to ${soldToParty}: ${orphans} material mapping(s) ` +
                    `use ${current.soldToParty} and no other customer carries it. Create the mappings for the new sold-to party first ` +
                    'or keep the current one.',
            });
        }
    }

    /**
     * Re-run mapping + validation for every open order. Each order is handled on its own:
     * a technical error is recorded in the result and in the order's event log, and the
     * remaining orders are still processed.
     */
    async _revalidateOpenOrders() {
        const { InboundOrders, InboundIssues } = this.entities;
        const LOG = cds.log('po2so');
        const open = (await SELECT.from(InboundOrders).columns('ID', 'customerPoNumber', 'status', 'extractionMethod')
            .where({ status: { 'not in': CLOSED_STATUSES } }).orderBy('createdAt', 'ID'));
        const eligible = open.filter((o) => o.extractionMethod);

        const results = [];
        for (const order of eligible) {
            try {
                const summary = await validateInboundOrder(order.ID);
                results.push({ ID: order.ID, customerPoNumber: order.customerPoNumber, previousStatus: order.status,
                    status: summary.status, errorCount: summary.errorCount, error: null });
            } catch (e) {
                LOG.error(`Revalidation of inbound order ${order.ID} failed:`, e);
                const message = `Revalidation failed: ${e.message}`.slice(0, 1000);
                await INSERT.into('po2so.InboundEvents').entries({ parent_ID: order.ID, status: order.status, message });
                const { count } = await SELECT.one.from(InboundIssues).columns('count(1) as count').where({ parent_ID: order.ID, severity: 'ERROR' });
                results.push({ ID: order.ID, customerPoNumber: order.customerPoNumber, previousStatus: order.status,
                    status: order.status, errorCount: count, error: message });
            }
        }

        const count = (status) => results.filter((r) => !r.error && r.status === status).length;
        return {
            checked: results.length,
            changed: results.filter((r) => r.status !== r.previousStatus).length,
            validated: count('VALIDATED'),
            needsReview: count('NEEDS_REVIEW'),
            failed: count('FAILED'),
            errors: results.filter((r) => r.error).length,
            skipped: open.length - eligible.length,
            results,
        };
    }

    async _rejectConflictingKey(req, entity, rule) {
        // the last key is the "natural" key; earlier keys (soldToParty) scope it
        const keyField = rule.keys[rule.keys.length - 1];
        const scope = Object.fromEntries(rule.keys.slice(0, -1).map((k) => [k, req.data[k]]));
        // case-insensitive keys: compare in JS against all rows in scope (small master-data tables)
        const filter = rule.caseInsensitiveKey ? scope : { ...scope, [keyField]: req.data[keyField] };
        const query = SELECT.from(entity).columns(keyField);
        const candidates = await (Object.keys(filter).length ? query.where(filter) : query);
        const clash = candidates.find((row) => sameKey(row[keyField], req.data[keyField], rule.caseInsensitiveKey));
        if (clash) {
            const scopeText = scope.soldToParty ? ` (sold-to party ${scope.soldToParty})` : '';
            return req.reject({
                status: 409,
                code: 'MAPPING_CONFLICT',
                target: keyField,
                message: conflictMessage(rule, keyField, req.data[keyField], clash[keyField], scopeText),
            });
        }
    }

    async _rejectUnknownSoldTo(req, Customers) {
        const { soldToParty } = req.data;
        const customers = await SELECT.from(Customers).columns('customerId', 'active').where({ soldToParty });
        if (!customers.some((c) => c.active !== false)) {
            return req.reject({
                status: 400,
                code: 'UNKNOWN_SOLD_TO',
                target: 'soldToParty',
                message: customers.length
                    ? `Sold-to party '${soldToParty}' belongs only to inactive customers (${customers.map((c) => c.customerId).join(', ')}).`
                    : `Sold-to party '${soldToParty}' does not belong to any maintained customer.`,
            });
        }
    }

    /**
     * Data integrity: the original file reference, validation issues, the append-only
     * event log and item ownership are system-managed. The CDS annotations (@readonly,
     * @Core.Immutable) make CAP drop such input silently; this check runs before that
     * cleansing and rejects the request explicitly, so a client never assumes the change
     * succeeded. It runs for every request, including each $batch sub-request.
     */
    async handle(req) {
        if (req.event === 'UPDATE' && req.data && typeof req.data === 'object') {
            const { InboundOrders, InboundItems } = this.entities;
            if (req.target === InboundOrders) {
                const fields = protectedFieldsIn(req.data, PROTECTED_ORDER_FIELDS);
                if (fields.length) {
                    return req.reject(400, `Field(s) ${fields.join(', ')} are system-managed and cannot be changed.`);
                }
                // deep update of items must not re-assign them either
                if (Array.isArray(req.data.items) && req.data.items.some((i) => protectedFieldsIn(i, PROTECTED_ITEM_FIELDS).length)) {
                    return req.reject(400, 'Items cannot be moved to another inbound order.');
                }
            } else if (req.target === InboundItems && protectedFieldsIn(req.data, PROTECTED_ITEM_FIELDS).length) {
                return req.reject(400, 'Items cannot be moved to another inbound order.');
            }
        }
        return super.handle(req);
    }
}

/** Resolve the parent order ID of an InboundItems request (direct or via navigation). */
async function parentOf(req) {
    // navigation: InboundOrders(ID)/items[(ID)]
    if (req.params.length > 1 || (req.event === 'CREATE' && req.params.length === 1)) {
        const p = req.params[0];
        return p?.ID ?? p;
    }
    if (req.data?.parent_ID) return req.data.parent_ID;
    const itemId = req.params[0]?.ID ?? req.params[0] ?? req.data?.ID;
    if (!itemId) return null;
    const item = await SELECT.one.from('po2so.InboundItems', itemId).columns('parent_ID');
    return item?.parent_ID ?? null;
}
