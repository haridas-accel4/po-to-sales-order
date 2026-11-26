/**
 * Pure helpers for the inbound PO review / correction dialog.
 * No UI5 dependencies, so the logic can be unit-tested in Node (test/unit/review-logic.test.js).
 *
 * Only fields the backend allows a reviewer to change are ever sent
 * (see srv/sales-order-service.cds: everything else is @readonly or derived):
 *   InboundOrders: customerId, customerPoNumber, poDate, requestedDeliveryDate
 *   InboundItems:  customerMaterial, description, quantity, customerUom
 * SAP material / SAP UoM come from the mapping tables, status is set by the backend.
 */
sap.ui.define([], function () {
    "use strict";

    const HEADER_FIELDS = ["customerId", "customerPoNumber", "poDate", "requestedDeliveryDate"];
    const ITEM_FIELDS = ["customerMaterial", "description", "quantity", "customerUom"];
    const MAX_LENGTH = { customerPoNumber: 35, customerMaterial: 35, description: 100, customerUom: 10 };

    /** Human-readable labels for backend issue field names (pipeline + template columns). */
    const FIELD_LABELS = {
        customerId: "Customer",
        customerPoNumber: "Customer PO Number",
        poDate: "PO Date",
        requestedDeliveryDate: "Requested Delivery Date",
        extractionConfidence: "Extraction Confidence",
        lineNumber: "Item Number",
        customerMaterial: "Customer Material",
        description: "Description",
        quantity: "Quantity",
        customerUom: "External UoM",
        CustomerPO: "CustomerPO (file)",
        PODate: "PODate (file)",
        DeliveryDate: "DeliveryDate (file)",
        Line: "Line (file)",
        CustomerMaterial: "CustomerMaterial (file)",
        Description: "Description (file)",
        Quantity: "Quantity (file)",
        UoM: "UoM (file)",
        UnitPrice: "UnitPrice (file)"
    };

    const QUANTITY_RE = /^-?\d{1,10}(\.\d{1,3})?$/;

    function text(value) {
        if (value === null || value === undefined) {
            return null;
        }
        const s = String(value).trim();
        return s === "" ? null : s;
    }

    /** True for a real calendar date in ISO format (rejects e.g. 2027-02-30). */
    function isValidIsoDate(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
        if (!m) {
            return false;
        }
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    }

    /** Decimal string from the backend ("100.000") -> editable string ("100"). */
    function quantityToText(value) {
        if (value === null || value === undefined || value === "") {
            return "";
        }
        const n = Number(value);
        return Number.isFinite(n) ? String(n) : String(value);
    }

    /** Editable snapshot of an order as returned by GET InboundOrders(ID)?$expand=items. */
    function toDraft(order) {
        return {
            header: {
                customerId: order.customerId || null,
                customerPoNumber: order.customerPoNumber || null,
                poDate: order.poDate || null,
                requestedDeliveryDate: order.requestedDeliveryDate || null
            },
            items: (order.items || []).map(function (item) {
                return {
                    ID: item.ID,
                    lineNumber: item.lineNumber,
                    customerMaterial: item.customerMaterial || null,
                    description: item.description || null,
                    quantity: quantityToText(item.quantity),
                    customerUom: item.customerUom || null
                };
            })
        };
    }

    /** Whether the order can be corrected in the UI, and why not. */
    function reviewState(order) {
        if (order.status === "CREATED") {
            return { editable: false, reason: "A Sales Order has been created for this PO; it can no longer be changed." };
        }
        if (!order.extractionMethod) {
            return {
                editable: false,
                reason: "The file could not be extracted, so there is no data to correct. Fix the file and upload it again."
            };
        }
        return { editable: true, reason: "" };
    }

    /**
     * Client-side format checks (the backend still performs all business validation).
     * @returns {{header:Object<string,string>, items:Object<string,Object<string,string>>, count:number}}
     */
    function validateDraft(draft, invalidInputs) {
        const result = { header: {}, items: {}, count: 0 };
        const add = function (target, field, message) {
            target[field] = message;
            result.count++;
        };
        const invalid = invalidInputs || {};

        const h = draft.header;
        ["poDate", "requestedDeliveryDate"].forEach(function (field) {
            if (invalid[field]) {
                add(result.header, field, "Enter a valid date.");
            } else if (text(h[field]) && !isValidIsoDate(h[field])) {
                add(result.header, field, "Enter a valid date.");
            }
        });
        if (text(h.customerPoNumber) && text(h.customerPoNumber).length > MAX_LENGTH.customerPoNumber) {
            add(result.header, "customerPoNumber", "Maximum " + MAX_LENGTH.customerPoNumber + " characters.");
        }

        draft.items.forEach(function (item) {
            const errors = {};
            const q = text(item.quantity);
            if (!q) {
                errors.quantity = "Quantity is required.";
            } else if (!QUANTITY_RE.test(q)) {
                errors.quantity = "Enter a number with '.' as decimal separator and at most 3 decimals.";
            }
            ["customerMaterial", "description", "customerUom"].forEach(function (field) {
                const v = text(item[field]);
                if (v && v.length > MAX_LENGTH[field]) {
                    errors[field] = "Maximum " + MAX_LENGTH[field] + " characters.";
                }
            });
            const n = Object.keys(errors).length;
            if (n) {
                result.items[item.ID] = errors;
                result.count += n;
            }
        });
        return result;
    }

    function normalizeHeaderValue(field, value) {
        return text(value);
    }

    function normalizeItemValue(field, value) {
        if (field === "quantity") {
            const q = text(value);
            return q === null ? null : Number(q);
        }
        return text(value);
    }

    /**
     * Only the changed, editable fields.
     * @returns {{header:Object, items:Array<{ID:string, changes:Object}>, count:number}}
     */
    function buildChanges(original, draft) {
        const header = {};
        HEADER_FIELDS.forEach(function (field) {
            const before = normalizeHeaderValue(field, original.header[field]);
            const after = normalizeHeaderValue(field, draft.header[field]);
            if (before !== after) {
                header[field] = after;
            }
        });

        const originalItems = {};
        original.items.forEach(function (item) { originalItems[item.ID] = item; });

        const items = [];
        draft.items.forEach(function (item) {
            const before = originalItems[item.ID];
            if (!before) {
                return;
            }
            const changes = {};
            ITEM_FIELDS.forEach(function (field) {
                const a = normalizeItemValue(field, before[field]);
                const b = normalizeItemValue(field, item[field]);
                if (a !== b) {
                    changes[field] = b;
                }
            });
            if (Object.keys(changes).length) {
                items.push({ ID: item.ID, changes: changes });
            }
        });

        return { header: header, items: items, count: Object.keys(header).length + items.length };
    }

    /**
     * OData JSON $batch body: all PATCHes in one atomicity group, so a correction
     * is saved completely or not at all. Each PATCH triggers server-side revalidation.
     */
    function buildBatch(orderId, changes) {
        const requests = [];
        const json = { "content-type": "application/json" };
        if (Object.keys(changes.header).length) {
            requests.push({ id: "h", atomicityGroup: "review", method: "PATCH", url: "InboundOrders(" + orderId + ")", headers: json, body: changes.header });
        }
        changes.items.forEach(function (item, i) {
            requests.push({ id: "i" + i, atomicityGroup: "review", method: "PATCH", url: "InboundItems(" + item.ID + ")", headers: json, body: item.changes });
        });
        return { requests: requests };
    }

    /** Collect error messages from a JSON $batch response. */
    function batchErrors(batchResponse) {
        return ((batchResponse && batchResponse.responses) || [])
            .filter(function (r) { return r.status >= 400; })
            .map(function (r) {
                return (r.body && r.body.error && r.body.error.message) || ("HTTP " + r.status);
            });
    }

    /**
     * Map backend validation issues to field value states.
     * @returns {{header:Object, lines:Object<number,{fields:Object, highlight:string}>}}
     */
    function issueStates(issues) {
        const result = { header: {}, lines: {} };
        (issues || []).forEach(function (issue) {
            const state = issue.severity === "ERROR" ? "Error" : "Warning";
            const entry = { state: state, text: issue.message };
            let target;
            if (issue.lineNumber) {
                const line = result.lines[issue.lineNumber] || (result.lines[issue.lineNumber] = { fields: {}, highlight: "None" });
                if (line.highlight !== "Error") {
                    line.highlight = state;
                }
                target = line.fields;
            } else {
                target = result.header;
            }
            if (issue.field && (!target[issue.field] || target[issue.field].state !== "Error")) {
                target[issue.field] = entry;
            }
        });
        return result;
    }

    function fieldLabel(field) {
        return field ? (FIELD_LABELS[field] || field) : "";
    }

    return {
        HEADER_FIELDS: HEADER_FIELDS,
        ITEM_FIELDS: ITEM_FIELDS,
        isValidIsoDate: isValidIsoDate,
        quantityToText: quantityToText,
        toDraft: toDraft,
        reviewState: reviewState,
        validateDraft: validateDraft,
        buildChanges: buildChanges,
        buildBatch: buildBatch,
        batchErrors: batchErrors,
        issueStates: issueStates,
        fieldLabel: fieldLabel
    };
});
