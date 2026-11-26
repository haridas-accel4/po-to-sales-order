import { readFileSync } from 'node:fs';

/**
 * Load a dependency-free UI5 module (sap.ui.define([], factory)) in Node,
 * so frontend logic can be unit-tested without a browser.
 */
export function loadUi5Module(fileUrl) {
    let exported;
    const sap = {
        ui: {
            define: (deps, factory) => {
                if (deps.length) throw new Error('loadUi5Module only supports modules without dependencies');
                exported = factory();
            },
        },
    };
    new Function('sap', readFileSync(fileUrl, 'utf8'))(sap);
    return exported;
}

export const reviewLogicUrl = new URL('../../app/sales-order/webapp/model/reviewLogic.js', import.meta.url);
