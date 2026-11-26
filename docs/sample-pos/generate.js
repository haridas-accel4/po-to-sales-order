// Generates the demo PDFs in this folder:  node docs/sample-pos/generate.js
// Upload 1-3 with customer ACME; 4 shows a PDF that is not in the template (fails with the reason).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePdf, templatePages } from '../../test/support/make-pdf.js';
const out = path.dirname(fileURLToPath(import.meta.url)) + path.sep;

/** Template PO with a letterhead on the first page. */
function po(file, { company, address, header, rows, footer = [], rowsPerPage }) {
    const pages = templatePages({ header, rows, footer, rowsPerPage, title: 'PURCHASE ORDER' });
    pages[0].push({ x: 380, y: 800, text: company, size: 12 }, ...address.map((t, i) => ({ x: 380, y: 785 - i * 12, text: t, size: 9 })));
    pages.forEach((p, i) => p.push({ x: 50, y: 40, text: `${company} - Page ${i + 1} of ${pages.length}`, size: 8 }));
    writeFileSync(out + file, makePdf(pages));
    console.log('written', file);
}

const ACME = { company: 'ACME Industries Ltd.', address: ['12 Industrial Park Road', 'Pune 411019, India'] };

// 1. everything mapped -> VALIDATED -> sales order created (customer ACME)
po('1-acme-valid.pdf', { ...ACME,
    header: { 'Customer PO': 'ACME-PDF-1001', 'PO Date': '2026-11-26', 'Delivery Date': '2026-12-10' },
    rows: [
        ['10', 'ACME-BOLT-10', 'Hex bolt M10', '500', 'PCS', '0.25'],
        ['20', 'ACME-NUT-10', 'Hex nut M10', '500', 'PCS', '0.10'],
        ['30', 'ACME-WASH-10', 'Washer M10', '5', 'KG', '12.00'],
    ],
    footer: ['Total: 235.00 INR', 'Payment terms: 30 days net'],
});

// 2. unknown material + unknown unit -> NEEDS_REVIEW in Exceptions (customer ACME)
po('2-acme-needs-review.pdf', { ...ACME,
    header: { 'Customer PO': 'ACME-PDF-1002', 'PO Date': '2026-11-26' },
    rows: [
        ['10', 'ACME-BOLT-10', 'Hex bolt M10', '200', 'PCS', '0.25'],
        ['20', 'ACME-SCREW-8', 'Wood screw M8', '300', 'PCS', '0.08'],
        ['30', 'ACME-NUT-10', 'Hex nut M10', '4', 'CARTON', '15.00'],
    ],
});

// 3. table over two pages (header repeated) -> VALIDATED (customer ACME)
po('3-acme-two-pages.pdf', { ...ACME,
    header: { 'PO Number': 'ACME-PDF-1003', 'Order Date': '26.11.2026', 'Delivery Date': '15.12.2026' },
    rows: Array.from({ length: 12 }, (_, i) => {
        const [mat, text, uom, price] = [['ACME-BOLT-10', 'Hex bolt M10', 'PCS', '0.25'], ['ACME-NUT-10', 'Hex nut M10', 'PCS', '0.10'], ['ACME-WASH-10', 'Washer M10', 'KG', '12.00']][i % 3];
        return [String((i + 1) * 10), mat, text, String(uom === 'KG' ? 1 + i / 4 : 100 * (i + 1)), uom, price];
    }),
    rowsPerPage: 8,
});

// 4. not in the template (no item table header) -> FAILED with the reason
const pages = [[
    { x: 50, y: 800, text: 'Globex Corporation', size: 14 },
    { x: 50, y: 770, text: 'Order no. GX-7781 dated 26 November 2026' },
    { x: 50, y: 740, text: 'Please supply 250 pieces of item GX-1000 (hex bolts M10) at the agreed price.' },
    { x: 50, y: 725, text: 'Delivery to our Mumbai warehouse by mid-December.' },
    { x: 50, y: 695, text: 'Regards, Purchasing Department' },
]];
writeFileSync(out + '4-globex-free-text.pdf', makePdf(pages));
console.log('written 4-globex-free-text.pdf');
