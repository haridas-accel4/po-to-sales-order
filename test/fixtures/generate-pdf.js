// Generates the PDF template sample fixture:  node test/fixtures/generate-pdf.js
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, templatePages } from '../support/make-pdf.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

const pages = templatePages({
    header: { 'Customer PO': 'PO-2027-0201', 'PO Date': '2027-04-01', 'Delivery Date': '2027-04-20' },
    rows: [
        ['10', 'ACME-BOLT-10', 'Hex bolt M10', '100', 'PCS', '0.25'],
        ['20', 'ACME-NUT-10', 'Hex nut M10', '100', 'PCS', '0.10'],
        ['30', 'ACME-WASH-10', 'Washer M10', '2.5', 'KG', '12.00'],
    ],
    footer: ['Total: 65.00'],
});
writeFileSync(path.join(dir, 'sample-po-template.pdf'), makePdf(pages));
console.log('written sample-po-template.pdf');
