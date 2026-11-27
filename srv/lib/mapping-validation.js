/**
 * Input rules for the mapping master data (Customers, MaterialMappings, UomMappings).
 * Pure functions; the service handlers do the database lookups.
 *
 * The intake pipeline (srv/lib/mapping.js) matches external UoMs and customer
 * materials case-insensitively and trimmed, so keys that differ only in case or
 * surrounding blanks would make mapping ambiguous. They are treated as conflicts.
 */
import { cleanText } from './text.js';

export const MAPPING_RULES = {
    Customers: {
        label: 'Customer',
        keys: ['customerId'],
        required: ['customerId', 'customerName', 'soldToParty'],
        text: ['customerId', 'customerName', 'soldToParty', 'salesOrganization', 'distributionChannel', 'division', 'identifiers'],
        caseInsensitiveKey: false, // matched exactly by the pipeline
    },
    MaterialMappings: {
        label: 'Material mapping',
        keys: ['soldToParty', 'customerMaterial'],
        required: ['soldToParty', 'customerMaterial', 'material'],
        text: ['soldToParty', 'customerMaterial', 'material', 'description'],
        caseInsensitiveKey: true,
    },
    UomMappings: {
        label: 'UoM mapping',
        keys: ['externalUom'],
        required: ['externalUom', 'sapUnit'],
        text: ['externalUom', 'sapUnit'],
        caseInsensitiveKey: true,
    },
};

const FIELD_LABELS = {
    customerId: 'Customer ID',
    customerName: 'Customer name',
    soldToParty: 'Sold-to party',
    customerMaterial: 'Customer material',
    material: 'SAP material',
    externalUom: 'External UoM',
    sapUnit: 'SAP unit',
};

export const fieldLabel = (field) => FIELD_LABELS[field] ?? field;

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && cleanText(v) === '');

/** Trim the text fields present in the payload and strip invisible characters (in place). */
export function trimTextFields(data, fields) {
    for (const f of fields) {
        if (typeof data?.[f] === 'string') data[f] = cleanText(data[f]);
    }
    return data;
}

/**
 * Required-field check.
 * @param {object} data request payload (keys included)
 * @param {string[]} required
 * @param {{full:boolean}} opts full = create / replace: every required field must be present;
 *        otherwise (PATCH) only fields present in the payload must not be blank
 * @returns {Array<{field:string, message:string}>}
 */
export function missingRequired(data, required, { full }) {
    return required
        .filter((f) => (full ? isBlank(data?.[f]) : Object.hasOwn(data ?? {}, f) && isBlank(data[f])))
        .map((f) => ({ field: f, message: `${fieldLabel(f)} is required and must not be empty.` }));
}

/** Key comparison as performed by the intake pipeline. */
export function sameKey(a, b, caseInsensitive) {
    const n = (v) => cleanText(v);
    return caseInsensitive ? n(a).toUpperCase() === n(b).toUpperCase() : n(a) === n(b);
}

/** Conflict message for an existing row with the same (or case-variant) key. */
export function conflictMessage(rule, field, newValue, existingValue, scopeText = '') {
    if (existingValue === newValue) {
        return `${rule.label} for ${fieldLabel(field)} '${newValue}' already exists${scopeText}.`;
    }
    return `${fieldLabel(field)} '${newValue}' conflicts with the existing ${rule.label.toLowerCase()} '${existingValue}'${scopeText} ` +
        '(values are matched case-insensitively during PO processing).';
}
