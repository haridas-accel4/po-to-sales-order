import cds from '@sap/cds';
import { issue } from './validation.js';
import { cleanText } from './text.js';

/**
 * Master-data mapping. Lookups only use the maintained mapping tables;
 * nothing is guessed. Unknown values produce ERROR issues (-> NEEDS_REVIEW).
 */

const key = (s) => cleanText(s).toUpperCase();
const isActive = (row) => row.active !== false;

/**
 * Customer mapping: Customers.customerId -> sold-to party.
 * @returns {Promise<{customer:object|null, issues:object[]}>}
 */
export async function mapCustomer(customerId) {
    if (!customerId) {
        return { customer: null, issues: [issue('ERROR', 'CUSTOMER_MISSING',
            'No customer identified for this PO (see the processing log). Set the customer and revalidate, ' +
            'or add an identifier from this PO to the customer for future POs.', { field: 'customerId' })] };
    }
    const { Customers } = cds.entities('po2so');
    const customer = await SELECT.one.from(Customers).where({ customerId });
    if (!customer || !isActive(customer) || !customer.soldToParty) {
        return { customer: null, issues: [issue('ERROR', 'CUSTOMER_UNKNOWN',
            `Customer '${customerId}' is not maintained (or inactive / without sold-to party) in the customer mapping.`, { field: 'customerId' })] };
    }
    return { customer, issues: [] };
}

/** Load material mappings of one sold-to party: Map<CUSTOMERMATERIAL, material>. */
export async function loadMaterialMap(soldToParty) {
    if (!soldToParty) return new Map();
    const { MaterialMappings } = cds.entities('po2so');
    const rows = await SELECT.from(MaterialMappings).where({ soldToParty });
    return new Map(rows.filter((r) => isActive(r) && r.material).map((r) => [key(r.customerMaterial), r.material]));
}

/** Load UoM mappings: Map<EXTERNALUOM, sapUnit>. */
export async function loadUomMap() {
    const { UomMappings } = cds.entities('po2so');
    const rows = await SELECT.from(UomMappings);
    return new Map(rows.filter((r) => r.sapUnit).map((r) => [key(r.externalUom), r.sapUnit]));
}

/**
 * Pure mapping of items (customer material -> SAP material, external UoM -> SAP UoM).
 * @returns {{items:object[], issues:object[]}} items with `material` / `sapUom` set (or null)
 */
export function mapItems(items, materialMap, uomMap, { customerKnown = true } = {}) {
    const issues = [];
    const mapped = items.map((it) => {
        const lineNumber = it.lineNumber ?? null;
        const material = it.customerMaterial ? materialMap.get(key(it.customerMaterial)) ?? null : null;
        const sapUom = it.customerUom ? uomMap.get(key(it.customerUom)) ?? null : null;
        // without a known customer, material mapping cannot be resolved; the customer issue covers it
        if (it.customerMaterial && !material && customerKnown) {
            issues.push(issue('ERROR', 'MATERIAL_UNMAPPED',
                `Customer material '${it.customerMaterial}' has no SAP material mapping for this customer.`, { field: 'customerMaterial', lineNumber }));
        }
        if (it.customerUom && !sapUom) {
            issues.push(issue('ERROR', 'UOM_UNMAPPED', `Unit of measure '${it.customerUom}' has no SAP UoM mapping.`, { field: 'customerUom', lineNumber }));
        }
        return { ...it, material, sapUom };
    });
    return { items: mapped, issues };
}
