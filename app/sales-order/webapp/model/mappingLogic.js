/**
 * Pure helpers for mapping maintenance (Customers, MaterialMappings, UomMappings).
 * No UI5 dependencies, so the logic can be unit-tested in Node (test/unit/mapping-logic.test.js)
 * and reused by API tests to send exactly the requests the UI sends.
 *
 * The backend (srv/sales-order-service.js) remains authoritative for duplicates,
 * required fields, sold-to validity and referential integrity.
 */
sap.ui.define([], function () {
    "use strict";

    const TYPES = {
        customers: {
            entitySet: "Customers",
            title: "Customers",
            singular: "customer",
            heading: "Customer",
            keys: ["customerId"],
            canDeactivate: true,
            fields: [
                { name: "customerId", label: "Customer ID", maxLength: 20, required: true },
                { name: "customerName", label: "Customer Name", maxLength: 100, required: true },
                { name: "soldToParty", label: "Sold-to Party", maxLength: 10, required: true },
                { name: "salesOrganization", label: "Sales Organization", maxLength: 4 },
                { name: "distributionChannel", label: "Distribution Channel", maxLength: 2 },
                { name: "division", label: "Division", maxLength: 2 },
                { name: "identifiers", label: "Identifiers", maxLength: 1000 }
            ]
        },
        materials: {
            entitySet: "MaterialMappings",
            title: "Material Mappings",
            singular: "material mapping",
            heading: "Material Mapping",
            keys: ["soldToParty", "customerMaterial"],
            canDeactivate: true,
            fields: [
                { name: "soldToParty", label: "Sold-to Party", maxLength: 10, required: true },
                { name: "customerMaterial", label: "Customer Material", maxLength: 35, required: true },
                { name: "material", label: "SAP Material", maxLength: 40, required: true },
                { name: "description", label: "Description", maxLength: 100 }
            ]
        },
        uoms: {
            entitySet: "UomMappings",
            title: "UoM Mappings",
            singular: "UoM mapping",
            heading: "UoM Mapping",
            keys: ["externalUom"],
            canDeactivate: false, // no 'active' flag in the data model
            fields: [
                { name: "externalUom", label: "External UoM", maxLength: 10, required: true },
                { name: "sapUnit", label: "SAP Unit", maxLength: 3, required: true }
            ]
        }
    };

    function text(value) {
        if (value === null || value === undefined) {
            return "";
        }
        return String(value).trim();
    }

    /** OData key predicate, e.g. MaterialMappings(soldToParty='1',customerMaterial='A%2FB'). */
    function keyPredicate(type, row) {
        const def = TYPES[type];
        const literal = function (v) { return "'" + encodeURIComponent(String(v).replace(/'/g, "''")) + "'"; };
        if (def.keys.length === 1) {
            return def.entitySet + "(" + literal(row[def.keys[0]]) + ")";
        }
        return def.entitySet + "(" + def.keys.map(function (k) { return k + "=" + literal(row[k]); }).join(",") + ")";
    }

    /** Empty edit draft for a new mapping, optionally prefilled. */
    function newDraft(type, prefill) {
        const draft = {};
        TYPES[type].fields.forEach(function (f) { draft[f.name] = ""; });
        return Object.assign(draft, prefill || {});
    }

    /** Edit draft from an existing row (only maintainable fields). */
    function draftFromRow(type, row) {
        const draft = {};
        TYPES[type].fields.forEach(function (f) { draft[f.name] = row[f.name] === null || row[f.name] === undefined ? "" : String(row[f.name]); });
        return draft;
    }

    /**
     * Client-side checks before sending (required, max length).
     * @returns {Object<string,string>} field -> message
     */
    function validateDraft(type, draft) {
        const errors = {};
        TYPES[type].fields.forEach(function (f) {
            const v = text(draft[f.name]);
            if (f.required && !v) {
                errors[f.name] = f.label + " is required.";
            } else if (v.length > f.maxLength) {
                errors[f.name] = f.label + ": maximum " + f.maxLength + " characters.";
            }
        });
        return errors;
    }

    /**
     * Request body. New: all fields (trimmed, blanks omitted). Existing: only changed
     * non-key fields (blanks sent as null); keys are never sent on update.
     */
    function buildPayload(type, draft, original) {
        const def = TYPES[type];
        const body = {};
        def.fields.forEach(function (f) {
            const v = text(draft[f.name]);
            if (!original) {
                if (v) {
                    body[f.name] = v;
                }
            } else if (def.keys.indexOf(f.name) < 0 && v !== text(original[f.name])) {
                body[f.name] = v === "" ? null : v;
            }
        });
        return body;
    }

    /** Case-insensitive search over all displayed fields of a row. */
    function filterRows(type, rows, query) {
        const terms = text(query).toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) {
            return rows.slice();
        }
        const fields = TYPES[type].fields.map(function (f) { return f.name; }).concat(["customerName"]);
        return rows.filter(function (row) {
            return terms.every(function (term) {
                return fields.some(function (f) { return text(row[f]).toLowerCase().indexOf(term) >= 0; });
            });
        });
    }

    /** Sold-to choices for material mappings: active customers, one entry per sold-to party. */
    function soldToOptions(customers) {
        const seen = {};
        return (customers || [])
            .filter(function (c) { return c.active !== false && text(c.soldToParty); })
            .filter(function (c) { return seen[c.soldToParty] ? false : (seen[c.soldToParty] = true); })
            .map(function (c) { return { key: c.soldToParty, text: c.soldToParty, additionalText: c.customerName }; });
    }

    /**
     * Mapping draft for an unmapped-issue in the review dialog.
     * @returns {{type:string, draft:object, locked:string[]}|null}
     */
    function draftFromIssue(issue, order, item) {
        if (!issue || !item) {
            return null;
        }
        if (issue.code === "MATERIAL_UNMAPPED" && order.soldToParty) {
            return {
                type: "materials",
                draft: newDraft("materials", { soldToParty: order.soldToParty, customerMaterial: text(item.customerMaterial), description: text(item.description) }),
                locked: ["soldToParty", "customerMaterial"]
            };
        }
        if (issue.code === "UOM_UNMAPPED") {
            return { type: "uoms", draft: newDraft("uoms", { externalUom: text(item.customerUom) }), locked: ["externalUom"] };
        }
        return null;
    }

    /** Field-level messages from an OData error (single error or details with targets). */
    function errorTargets(error) {
        const result = {};
        const list = error && error.details && error.details.length ? error.details : [error || {}];
        list.forEach(function (e) {
            if (e.target) {
                result[e.target.replace(/^in\//, "")] = e.message;
            }
        });
        return result;
    }

    /** Human-readable summary of a revalidateOpenOrders() result. */
    function revalidationSummary(result) {
        const parts = [
            "Checked " + result.checked + " open order(s): " +
            result.validated + " validated, " + result.needsReview + " need review, " + result.failed + " failed."
        ];
        parts.push(result.changed + " status change(s).");
        if (result.errors) {
            parts.push(result.errors + " order(s) could not be revalidated because of a technical error.");
        }
        if (result.skipped) {
            parts.push(result.skipped + " open order(s) were skipped because their file was never extracted.");
        }
        return parts.join(" ");
    }

    function revalidationDetails(result) {
        return (result.results || [])
            .filter(function (r) { return r.error || r.status !== r.previousStatus; })
            .map(function (r) {
                return (r.customerPoNumber || r.ID) + ": " + r.previousStatus + " -> " + r.status + (r.error ? " (" + r.error + ")" : "");
            })
            .join("\n");
    }

    return {
        TYPES: TYPES,
        keyPredicate: keyPredicate,
        newDraft: newDraft,
        draftFromRow: draftFromRow,
        validateDraft: validateDraft,
        buildPayload: buildPayload,
        filterRows: filterRows,
        soldToOptions: soldToOptions,
        draftFromIssue: draftFromIssue,
        errorTargets: errorTargets,
        revalidationSummary: revalidationSummary,
        revalidationDetails: revalidationDetails
    };
});
