/**
 * Pure logic for the purchase order list personalization:
 *   - "Adapt Filters": which optional filter fields are shown in the filter bar
 *   - "Table Settings": which columns are shown and how the table is sorted
 *   - persistence of both as per-browser user preferences
 * No UI5 dependencies, so it can be unit-tested in Node (test/unit/list-settings-logic.test.js).
 */
sap.ui.define([], function () {
    "use strict";

    const STORAGE_KEY = "po2so.salesorder.listSettings.v1";

    /** Optional filter fields (the free-text search is always shown). Keys match filterLogic.emptyFilters(). */
    const FILTER_FIELDS = [
        { key: "poNumber", label: "Purchase Order" },
        { key: "customer", label: "Customer" },
        { key: "status", label: "Status" },
        { key: "fileType", label: "File Type" },
        { key: "dateFrom", label: "PO Date From" },
        { key: "dateTo", label: "PO Date To" }
    ];

    /** Table columns in display order; sortBy is the record field used for sorting. */
    const COLUMNS = [
        { key: "fileName", label: "File Name", sortBy: "fileName" },
        { key: "customer", label: "Customer", sortBy: "customer" },
        { key: "poNumber", label: "Purchase Order", sortBy: "poNumber" },
        { key: "poDate", label: "PO Date", sortBy: "poDateIso" },
        { key: "fileType", label: "File Type", sortBy: "fileType" },
        { key: "source", label: "Source", sortBy: "sourceText" },
        { key: "status", label: "Status", sortBy: "statusText" },
        { key: "salesOrder", label: "Sales Order", sortBy: "salesOrder" },
        { key: "createdOn", label: "Created On", sortBy: "createdAtIso" }
    ];

    function allVisible(defs) {
        const result = {};
        defs.forEach(function (d) { result[d.key] = true; });
        return result;
    }

    /** Default settings: every filter and column shown, backend order (newest first) kept. */
    function defaultSettings() {
        return {
            filterVisible: allVisible(FILTER_FIELDS),
            columnVisible: allVisible(COLUMNS),
            sort: []
        };
    }

    /**
     * Make stored / user-provided settings safe: unknown keys are dropped, missing keys get
     * their default, at least one column stays visible, sort entries must name a known column.
     */
    function normalize(settings) {
        const result = defaultSettings();
        const s = settings && typeof settings === "object" ? settings : {};
        [["filterVisible", FILTER_FIELDS], ["columnVisible", COLUMNS]].forEach(function (pair) {
            const source = s[pair[0]] && typeof s[pair[0]] === "object" ? s[pair[0]] : {};
            pair[1].forEach(function (d) {
                if (typeof source[d.key] === "boolean") {
                    result[pair[0]][d.key] = source[d.key];
                }
            });
        });
        if (!COLUMNS.some(function (c) { return result.columnVisible[c.key]; })) {
            result.columnVisible = allVisible(COLUMNS);
        }
        const seen = {};
        result.sort = (Array.isArray(s.sort) ? s.sort : []).filter(function (entry) {
            const ok = entry && COLUMNS.some(function (c) { return c.key === entry.key; }) && !seen[entry.key];
            if (ok) {
                seen[entry.key] = true;
            }
            return ok;
        }).map(function (entry) {
            return { key: entry.key, descending: entry.descending === true };
        });
        return result;
    }

    /** Read settings from a Storage-like object; never throws (private mode, blocked storage, bad JSON). */
    function load(storage) {
        try {
            const raw = storage && storage.getItem(STORAGE_KEY);
            return normalize(raw ? JSON.parse(raw) : null);
        } catch {
            return defaultSettings();
        }
    }

    /** @returns {boolean} whether the settings were stored */
    function save(storage, settings) {
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(normalize(settings)));
            return true;
        } catch {
            return false;
        }
    }

    /** @returns {boolean} whether stored settings were removed */
    function clear(storage) {
        try {
            storage.removeItem(STORAGE_KEY);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Hidden filter fields must not keep filtering the list invisibly:
     * returns a copy of the filter values with hidden fields reset to "".
     */
    function clearHiddenFilters(filters, filterVisible) {
        const result = Object.assign({}, filters);
        FILTER_FIELDS.forEach(function (f) {
            if (filterVisible[f.key] === false) {
                result[f.key] = "";
            }
        });
        return result;
    }

    // ---------------------------------------------------------------- sap.m.p13n panel data

    /** p13n SelectionPanel items for "Adapt Filters". */
    function filterPanelData(settings) {
        return FILTER_FIELDS.map(function (f) {
            return { name: f.key, label: f.label, visible: settings.filterVisible[f.key] !== false };
        });
    }

    /** p13n SelectionPanel items for the table columns. */
    function columnPanelData(settings) {
        return COLUMNS.map(function (c) {
            return { name: c.key, label: c.label, visible: settings.columnVisible[c.key] !== false };
        });
    }

    /** p13n SortPanel items: every column, active sorts first in priority order. */
    function sortPanelData(settings) {
        const active = settings.sort.map(function (s) {
            const column = COLUMNS.find(function (c) { return c.key === s.key; });
            return { name: s.key, label: column.label, sorted: true, descending: s.descending };
        });
        return active.concat(COLUMNS.filter(function (c) {
            return !settings.sort.some(function (s) { return s.key === c.key; });
        }).map(function (c) {
            return { name: c.key, label: c.label, sorted: false, descending: false };
        }));
    }

    /** Visibility map from SelectionPanel items ({name, visible}). */
    function visibilityFromPanel(items, defs) {
        const result = {};
        defs.forEach(function (d) {
            const item = (items || []).find(function (i) { return i.name === d.key; });
            result[d.key] = item ? item.visible !== false : true;
        });
        return result;
    }

    /** Sort list from SortPanel items ({name, sorted, descending}). */
    function sortFromPanel(items) {
        return (items || []).filter(function (i) { return i.sorted; }).map(function (i) {
            return { key: i.name, descending: !!i.descending };
        });
    }

    // ---------------------------------------------------------------- sorting

    function compareValues(a, b) {
        const x = a === null || a === undefined ? "" : String(a);
        const y = b === null || b === undefined ? "" : String(b);
        if (x === y) {
            return 0;
        }
        // empty values last in ascending order
        if (!x) {
            return 1;
        }
        if (!y) {
            return -1;
        }
        return x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" });
    }

    /** Stable multi-column sort; returns a new array, the input order is kept for ties / no sort. */
    function sortRecords(records, sort) {
        if (!sort || !sort.length) {
            return records.slice();
        }
        const keys = sort.map(function (s) {
            const column = COLUMNS.find(function (c) { return c.key === s.key; });
            return { field: column ? column.sortBy : s.key, sign: s.descending ? -1 : 1 };
        });
        return records.map(function (r, i) { return { r: r, i: i }; }).sort(function (a, b) {
            for (let k = 0; k < keys.length; k++) {
                const result = compareValues(a.r[keys[k].field], b.r[keys[k].field]);
                if (result) {
                    return result * keys[k].sign;
                }
            }
            return a.i - b.i;
        }).map(function (e) { return e.r; });
    }

    return {
        STORAGE_KEY: STORAGE_KEY,
        FILTER_FIELDS: FILTER_FIELDS,
        COLUMNS: COLUMNS,
        defaultSettings: defaultSettings,
        normalize: normalize,
        load: load,
        save: save,
        clear: clear,
        clearHiddenFilters: clearHiddenFilters,
        filterPanelData: filterPanelData,
        columnPanelData: columnPanelData,
        sortPanelData: sortPanelData,
        visibilityFromPanel: visibilityFromPanel,
        sortFromPanel: sortFromPanel,
        sortRecords: sortRecords
    };
});
