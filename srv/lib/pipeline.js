import cds from '@sap/cds';
import { getConfig } from './config.js';
import { ExtractionError } from './errors.js';
import { validateFile } from './file-validation.js';
import { extractPurchaseOrder, extractDocumentText } from './extraction/index.js';
import { identifyCustomer } from './customer-identification.js';
import { mapCustomer, loadMaterialMap, loadUomMap, mapItems } from './mapping.js';
import { validateRequiredFields, validateQuantities, validateConfidence, determineStatus, issue } from './validation.js';
import { connectSalesOrderApi, toSalesOrderPayload, findSalesOrder, createSalesOrder, describeSapError } from './sap-sales-order.js';
import { notifyOrderEvent, notifySalesOrderFailure } from './notifications/index.js';

/**
 * Inbound PO processing pipeline - the single path for every intake channel
 * (file upload now, e-mail later):
 *
 *   ingestDocument()        validate file -> store original -> RECEIVED
 *   processInboundOrder()   extract (deterministic CSV/XLSX, PDF provider) -> EXTRACTED | FAILED
 *   validateInboundOrder()  customer / material / UoM mapping, field, quantity,
 *                           confidence and duplicate checks -> VALIDATED | NEEDS_REVIEW | FAILED
 *   postSalesOrder()        duplicate check in SAP, create through the Sales Order API
 *                           -> CREATED | FAILED (SAP rejected) | VALIDATED (SAP not reachable)
 *
 * Only VALIDATED orders are posted, by deterministic code - never by an LLM.
 * All functions run in the caller's transaction (cds.context).
 */

const LOG = cds.log('po2so');
const db = () => cds.entities('po2so');

/** Statuses from which an order may no longer change. */
export const FINAL_STATUSES = ['CREATED'];

async function logEvent(orderId, status, message) {
    const { InboundEvents } = db();
    await INSERT.into(InboundEvents).entries({ parent_ID: orderId, status, message: message?.slice(0, 1000) ?? null });
}

async function setStatus(orderId, status, message, extra = {}) {
    const { InboundOrders } = db();
    await UPDATE(InboundOrders, orderId).with({ status, ...extra });
    await logEvent(orderId, status, message);
}

async function replaceIssues(orderId, issues) {
    const { InboundIssues } = db();
    await DELETE.from(InboundIssues).where({ parent_ID: orderId });
    if (issues.length) {
        await INSERT.into(InboundIssues).entries(issues.map((i) => ({ ...i, message: i.message?.slice(0, 500), parent_ID: orderId })));
    }
}

async function toBuffer(content) {
    if (content === null || content === undefined) return null;
    if (Buffer.isBuffer(content)) return content;
    if (typeof content === 'string') return Buffer.from(content, 'base64');
    const chunks = [];
    for await (const chunk of content) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

/**
 * Entry point for every intake channel.
 * Validates and stores the original file, creates the InboundOrder and runs the pipeline.
 *
 * Without a customerId the customer is identified from the document and the e-mail text
 * (sender, subject, body) by the identifiers maintained on the customers.
 *
 * @param {{source:'UPLOAD'|'EMAIL', fileName:string, mimeType:string, buffer:Buffer, customerId?:string,
 *          emailText?:string}} doc
 * @returns {Promise<{ID:string, status:string, errorMessage:string|null, errorCount:number, warningCount:number}>}
 * @throws {FileValidationError} if the file is rejected (nothing is stored)
 */
export async function ingestDocument({ source = 'UPLOAD', fileName, mimeType, buffer, customerId = null, emailText = '' }) {
    const config = getConfig();
    const meta = validateFile({ fileName, mimeType, buffer, maxFileSize: config.maxFileSize });

    let identification = null;
    if (!customerId) {
        const { Customers } = db();
        const customers = await SELECT.from(Customers).columns('customerId', 'identifiers', 'active').where({ identifiers: { '!=': null } });
        identification = identifyCustomer({ documentText: await extractDocumentText({ fileType: meta.fileType, buffer }), emailText }, customers);
        customerId = identification.customerId;
    }

    const { InboundOrders, InboundFiles } = db();
    const fileId = cds.utils.uuid();
    const orderId = cds.utils.uuid();

    await INSERT.into(InboundFiles).entries({
        ID: fileId, fileName, mimeType: meta.mimeType, size: meta.size, sha256: meta.sha256, content: buffer,
    });
    await INSERT.into(InboundOrders).entries({
        ID: orderId, source, fileName, mimeType: meta.mimeType, customerId: customerId || null,
        status: 'RECEIVED', file_ID: fileId,
    });
    await logEvent(orderId, 'RECEIVED', `${source}: ${fileName} (${meta.size} bytes, sha256 ${meta.sha256})`);
    if (identification) await logEvent(orderId, 'RECEIVED', identification.message);
    LOG.info(`Inbound order ${orderId} received from ${source}: ${fileName}${identification ? ` - ${identification.message}` : ''}`);

    const result = await processInboundOrder(orderId, { buffer, fileType: meta.fileType });
    if (result.status === 'NEEDS_REVIEW' || result.status === 'FAILED') await notifyIntakeException(orderId, result.status);
    if (result.status === 'VALIDATED' && config.autoPost) return postSalesOrder(orderId);
    return result;
}

/**
 * Status e-mails for an order that stopped at intake (the notification module decides who
 * is told: today only for e-mailed POs). Later review edits do not e-mail again.
 */
async function notifyIntakeException(orderId, status) {
    const { InboundIssues } = db();
    const errors = await SELECT.from(InboundIssues).columns('code', 'message', 'lineNumber')
        .where({ parent_ID: orderId, severity: 'ERROR' });
    const type = status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW'
        : errors.some((i) => i.code === 'DUPLICATE_PO') ? 'DUPLICATE_PO' : 'EXTRACTION_FAILED';
    notifyOrderEvent({ orderId, type, messages: errors.map((i) => (i.lineNumber ? `Line ${i.lineNumber}: ` : '') + i.message) });
}

/**
 * Extract the stored file into header + items, then validate.
 * Replaces previously extracted data (used for first processing and reprocess()).
 */
export async function processInboundOrder(orderId, { buffer, fileType } = {}) {
    const { InboundOrders, InboundFiles, InboundItems } = db();
    const order = await SELECT.one.from(InboundOrders, orderId).columns('ID', 'fileName', 'file_ID');
    if (!order) throw new Error(`Inbound order ${orderId} not found`);

    if (!buffer) {
        const file = await SELECT.one.from(InboundFiles, order.file_ID).columns('content');
        buffer = await toBuffer(file?.content);
    }
    fileType ??= order.fileName.split('.').pop().toLowerCase();

    await DELETE.from(InboundItems).where({ parent_ID: orderId });

    let po;
    try {
        po = await extractPurchaseOrder({ fileType, buffer, config: getConfig() });
    } catch (e) {
        if (!(e instanceof ExtractionError)) throw e;
        const details = e.details?.length ? e.details : [{ message: e.message }];
        await replaceIssues(orderId, details.map((d) =>
            issue('ERROR', e.code, d.message, { field: d.field ?? null, lineNumber: d.rowNumber ?? null })));
        await setStatus(orderId, 'FAILED', e.message, {
            errorMessage: e.message, extractionMethod: null, extractionConfidence: null,
            customerPoNumber: null, poDate: null, requestedDeliveryDate: null, currency: null, soldToParty: null,
        });
        LOG.warn(`Inbound order ${orderId} extraction failed (${e.code}): ${e.message}`);
        return summarize(orderId);
    }

    await UPDATE(InboundOrders, orderId).with({
        customerPoNumber: po.header.customerPoNumber,
        poDate: po.header.poDate,
        requestedDeliveryDate: po.header.requestedDeliveryDate,
        currency: po.header.currency ?? null,
        extractionMethod: po.extraction.method,
        extractionConfidence: po.extraction.confidence,
        errorMessage: null,
    });
    await INSERT.into(InboundItems).entries(po.items.map((it) => ({
        parent_ID: orderId,
        lineNumber: it.lineNumber,
        customerMaterial: it.customerMaterial,
        description: it.description,
        quantity: it.quantity,
        customerUom: it.uom,
        customerUnitPrice: it.unitPrice, // informational only - never used as SAP price
        priceUnit: it.priceUnit ?? 1,
        requestedDeliveryDate: it.requestedDeliveryDate ?? null,
    })));
    await setStatus(orderId, 'EXTRACTED', `${po.items.length} item(s) extracted via ${po.extraction.method}`);

    return validateInboundOrder(orderId);
}

/**
 * Map and validate the current order data (after extraction or user corrections).
 * Sets VALIDATED, NEEDS_REVIEW or FAILED (duplicate).
 */
export async function validateInboundOrder(orderId) {
    const { InboundOrders, InboundItems, SalesOrders } = db();
    const config = getConfig();
    const order = await SELECT.one.from(InboundOrders, orderId);
    if (!order) throw new Error(`Inbound order ${orderId} not found`);
    if (FINAL_STATUSES.includes(order.status)) return summarize(orderId);

    const items = await SELECT.from(InboundItems).where({ parent_ID: orderId }).orderBy('lineNumber');
    const issues = [];

    // customer
    const { customer, issues: customerIssues } = await mapCustomer(order.customerId);
    issues.push(...customerIssues);
    const soldToParty = customer?.soldToParty ?? null;

    // fields, quantities, confidence
    issues.push(...validateRequiredFields(order, items));
    issues.push(...validateQuantities(items));
    issues.push(...validateConfidence(order.extractionConfidence, config.minExtractionConfidence));

    // material + UoM mapping
    const mapped = mapItems(items, await loadMaterialMap(soldToParty), await loadUomMap(), { customerKnown: !!customer });
    issues.push(...mapped.issues);
    for (const it of mapped.items) {
        await UPDATE(InboundItems, it.ID).with({ material: it.material, sapUom: it.sapUom });
    }

    // duplicate prevention: customer PO number + sold-to party
    let duplicate = null;
    if (soldToParty && order.customerPoNumber) {
        const other = await SELECT.one.from(InboundOrders).columns('ID', 'status')
            .where({ customerPoNumber: order.customerPoNumber, soldToParty, ID: { '!=': orderId }, status: { '!=': 'FAILED' } });
        const so = other ? null : await SELECT.one.from(SalesOrders).columns('ID', 'salesOrderNumber')
            .where({ customerPoNumber: order.customerPoNumber, soldToParty });
        if (other) duplicate = `inbound order ${other.ID} (status ${other.status})`;
        else if (so) duplicate = `sales order ${so.salesOrderNumber ?? so.ID}`;
        if (duplicate) {
            issues.unshift(issue('ERROR', 'DUPLICATE_PO',
                `Customer PO '${order.customerPoNumber}' for sold-to party ${soldToParty} already exists as ${duplicate}.`, { field: 'customerPoNumber' }));
        }
    }

    const status = duplicate ? 'FAILED' : determineStatus(issues);
    const errors = issues.filter((i) => i.severity === 'ERROR');
    const errorMessage = errors.length ? errors.map((i) => (i.lineNumber ? `Line ${i.lineNumber}: ` : '') + i.message).join('\n') : null;

    await replaceIssues(orderId, issues);
    await setStatus(orderId, status,
        status === 'VALIDATED' ? 'Validation passed' : `${errors.length} error(s): ${errors[0]?.message}`,
        { soldToParty, errorMessage });
    return summarize(orderId);
}

/**
 * Create the SAP sales order for a VALIDATED inbound order.
 * Does nothing for any other status, so it is safe to call after every validation.
 *
 *   duplicate in SAP (customer PO + sold-to) -> FAILED, existing order named
 *   SAP rejects the data                     -> FAILED, SAP messages as issues
 *   SAP not reachable / not authorized       -> stays VALIDATED with a warning; resubmit later
 *   created                                  -> CREATED with the SAP sales order number
 *
 * Every outcome triggers status e-mails: exceptions internally, "created" and the customer
 * confirmation for e-mailed POs (srv/lib/notifications: sent after commit, detached, never
 * affects the order).
 */
export async function postSalesOrder(orderId) {
    const { InboundOrders, InboundItems } = db();
    const order = await SELECT.one.from(InboundOrders, orderId);
    if (!order) throw new Error(`Inbound order ${orderId} not found`);
    if (order.status !== 'VALIDATED') return summarize(orderId);

    // validation guarantees an active, mapped customer; re-read it for the sales area
    const { customer } = await mapCustomer(order.customerId);
    if (!customer) return validateInboundOrder(orderId);
    const items = await SELECT.from(InboundItems).where({ parent_ID: orderId }).orderBy('lineNumber');
    const ref = { customerPoNumber: order.customerPoNumber, soldToParty: customer.soldToParty };

    let salesOrder;
    try {
        const s4 = await connectSalesOrderApi();
        const existing = await findSalesOrder(s4, ref);
        if (existing) {
            const message = `Customer PO '${ref.customerPoNumber}' for sold-to party ${ref.soldToParty} already exists in SAP as sales order ${existing}.`;
            await addIssues(orderId, [issue('ERROR', 'DUPLICATE_PO', message, { field: 'customerPoNumber' })]);
            await setStatus(orderId, 'FAILED', message, { errorMessage: message });
            notifySalesOrderFailure({ orderId, failureType: 'SAP_DUPLICATE', messages: [message] });
            return summarize(orderId);
        }
        salesOrder = await createSalesOrder(s4, toSalesOrderPayload(order, items, customer, { salesOrderType: getConfig().salesOrderType }));
    } catch (e) {
        const { business, httpStatus, messages } = describeSapError(e);
        if (business) {
            const text = messages.join('\n');
            await addIssues(orderId, messages.map((m) => issue('ERROR', 'SAP_ERROR', `SAP: ${m}`)));
            await setStatus(orderId, 'FAILED', `SAP rejected the sales order: ${text}`, { errorMessage: `SAP rejected the sales order:\n${text}` });
            LOG.warn(`Inbound order ${orderId}: SAP rejected the sales order (HTTP ${httpStatus}): ${text}`);
            notifySalesOrderFailure({ orderId, failureType: 'SAP_REJECTED', messages, httpStatus });
        } else {
            const text = `SAP Sales Order API not available${httpStatus ? ` (HTTP ${httpStatus})` : ''}: ${messages.join(' ')} Resubmit the order to try again.`;
            await addIssues(orderId, [issue('WARNING', 'SAP_UNAVAILABLE', text)]);
            await UPDATE(InboundOrders, orderId).with({ errorMessage: text });
            await logEvent(orderId, 'VALIDATED', text);
            LOG.error(`Inbound order ${orderId}: Sales Order API call failed`, e);
            notifySalesOrderFailure({ orderId, failureType: 'SAP_UNAVAILABLE', messages, httpStatus });
        }
        return summarize(orderId);
    }

    await setStatus(orderId, 'CREATED', `Sales order ${salesOrder} created in SAP`, { salesOrderNumber: salesOrder, errorMessage: null });
    LOG.info(`Inbound order ${orderId}: sales order ${salesOrder} created`);
    notifyOrderEvent({ orderId, type: 'SO_CREATED', messages: [`Sales order ${salesOrder}`] });
    return summarize(orderId);
}

async function addIssues(orderId, issues) {
    const { InboundIssues } = db();
    await INSERT.into(InboundIssues).entries(issues.map((i) => ({ ...i, message: i.message?.slice(0, 500), parent_ID: orderId })));
}

/** Compact result for API responses. */
export async function summarize(orderId) {
    const { InboundOrders, InboundIssues } = db();
    const order = await SELECT.one.from(InboundOrders, orderId).columns('ID', 'status', 'errorMessage', 'salesOrderNumber');
    const issues = await SELECT.from(InboundIssues).columns('severity').where({ parent_ID: orderId });
    return {
        ID: order.ID,
        status: order.status,
        salesOrderNumber: order.salesOrderNumber ?? null,
        errorMessage: order.errorMessage ?? null,
        errorCount: issues.filter((i) => i.severity === 'ERROR').length,
        warningCount: issues.filter((i) => i.severity === 'WARNING').length,
    };
}
