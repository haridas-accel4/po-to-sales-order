/**
 * Pure filter / search logic for the purchase order table.
 * No UI5 dependencies, so it can be unit-tested in Node (test/unit/filter-logic.test.js).
 *
 * Records are the table rows built by App.controller#_toRecord:
 *   { poNumber, fileName, customer ("Name (ID)"), customerId, soldToParty,
 *     status, fileType ("CSV"|"XLSX"|"PDF"), poDateIso ("YYYY-MM-DD"), ... }
 */
sap.ui.define([], function () {
    "use strict";

    /** Statuses shown per tab ("upload" shows the upload form, not the table). */
    const TAB_STATUSES = {
        processed:  ["EXTRACTED", "VALIDATED", "NEEDS_REVIEW", "CREATED"],
        sales:      ["CREATED"],
        exceptions: ["NEEDS_REVIEW", "FAILED"]
    };

    /** Fields searched by the free-text search. */
    const SEARCH_FIELDS = ["poNumber", "fileName", "customer", "customerId", "soldToParty", "sourceText"];

    /** Initial / cleared state of the filter bar, including the search text. */
    function emptyFilters() {
        return { search: "", poNumber: "", customer: "", status: "", fileType: "", dateFrom: "", dateTo: "" };
    }

    function normalize(value) {
        return value === null || value === undefined ? "" : String(value).trim().toLowerCase();
    }

    function contains(value, query) {
        return normalize(value).includes(query);
    }

    /**
     * Free-text search: every whitespace-separated term must occur in at least one
     * searchable field (case-insensitive). An empty query matches everything.
     */
    function matchesSearch(record, query) {
        const terms = normalize(query).split(/\s+/).filter(Boolean);
        return terms.every(function (term) {
            return SEARCH_FIELDS.some(function (field) { return contains(record[field], term); });
        });
    }

    /** @returns {string|null} message if the filter values are inconsistent */
    function validateFilters(filters) {
        if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) {
            return "'PO Date From' must not be after 'PO Date To'.";
        }
        return null;
    }

    /**
     * Apply search text, filter bar values and the selected tab.
     * @param {object[]} records
     * @param {object} filters values from the "filters" model (see emptyFilters)
     * @param {string} tab selected tab key
     * @returns {object[]} matching records (input order preserved)
     */
    function applyFilters(records, filters, tab) {
        const f = Object.assign(emptyFilters(), filters);
        const po = normalize(f.poNumber);
        const customer = normalize(f.customer);
        const tabStatuses = TAB_STATUSES[tab];

        return records.filter(function (r) {
            if (!matchesSearch(r, f.search)) {
                return false;
            }
            if (po && !contains(r.poNumber, po)) {
                return false;
            }
            if (customer && !contains(r.customer, customer) && !contains(r.customerId, customer) && !contains(r.soldToParty, customer)) {
                return false;
            }
            if (f.status && r.status !== f.status) {
                return false;
            }
            if (f.fileType && r.fileType !== f.fileType) {
                return false;
            }
            if (f.dateFrom && !(r.poDateIso && r.poDateIso >= f.dateFrom)) {
                return false;
            }
            if (f.dateTo && !(r.poDateIso && r.poDateIso <= f.dateTo)) {
                return false;
            }
            if (tabStatuses && !tabStatuses.includes(r.status)) {
                return false;
            }
            return true;
        });
    }

    /** Record counts per tab (independent of filters, as before). */
    function tabCounts(records) {
        const count = function (statuses) {
            return records.filter(function (r) { return statuses.includes(r.status); }).length;
        };
        return {
            processed: count(TAB_STATUSES.processed),
            salesOrders: count(TAB_STATUSES.sales),
            exceptions: count(TAB_STATUSES.exceptions)
        };
    }

    return {
        TAB_STATUSES: TAB_STATUSES,
        SEARCH_FIELDS: SEARCH_FIELDS,
        emptyFilters: emptyFilters,
        matchesSearch: matchesSearch,
        validateFilters: validateFilters,
        applyFilters: applyFilters,
        tabCounts: tabCounts
    };
});
