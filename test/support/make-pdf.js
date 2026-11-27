/**
 * Minimal PDF writer for tests and fixtures: places text at fixed positions, no dependency.
 *
 *   makePdf([ [ {x, y, text, size?}, ... ],   // page 1
 *             [ ... ] ])                       // page 2
 *
 * Coordinates are PDF points from the bottom-left corner of an A4 page (595 x 842).
 * Text uses the standard Helvetica font (WinAnsi), so only Latin-1 characters are supported.
 */

const escape = (s) => String(s).replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * @param {Array<Array<{x:number, y:number, text:string, size?:number}>>} pages
 * @returns {Buffer}
 */
export function makePdf(pages) {
    const objects = []; // index i -> object number i + 1
    const add = (body) => objects.push(body) && objects.length;

    const catalog = add(null);
    const pageTree = add(null);
    const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

    const pageRefs = pages.map((texts) => {
        const content = texts
            .map(({ x, y, text, size = 10 }) => `BT /F1 ${size} Tf ${x} ${y} Td (${escape(text)}) Tj ET`)
            .join('\n');
        const stream = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
        return add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 595 842] ` +
            `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`);
    });

    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
    objects[pageTree - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;

    let out = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(out, 'latin1'));
        out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
}

/**
 * Lay out a purchase order in the PDF template: a header block with labelled fields
 * and an item table. Returns the pages for makePdf().
 *
 * @param {{header?:Record<string,string>, columns?:string[], rows:Array<Array<string>>,
 *          rowsPerPage?:number, footer?:string[], title?:string}} po
 */
export function templatePages({
    header = {}, columns = ['Line', 'Customer Material', 'Description', 'Quantity', 'UoM', 'Unit Price'],
    rows, rowsPerPage = 40, footer = [], title = 'PURCHASE ORDER', xs = [50, 85, 200, 380, 440, 490],
}) {
    const pages = [];
    for (let start = 0; start === 0 || start < rows.length; start += rowsPerPage) {
        const texts = [];
        let y = 800;
        if (start === 0) {
            texts.push({ x: 50, y, text: title, size: 16 });
            y -= 30;
            for (const [label, value] of Object.entries(header)) {
                texts.push({ x: 50, y, text: `${label}:` });
                texts.push({ x: 160, y, text: value });
                y -= 16;
            }
            y -= 14;
        }
        columns.forEach((c, i) => texts.push({ x: xs[i], y, text: c }));
        y -= 18;
        for (const row of rows.slice(start, start + rowsPerPage)) {
            row.forEach((v, i) => { if (v !== '' && v != null) texts.push({ x: xs[i], y, text: v }); });
            y -= 15;
        }
        pages.push(texts);
    }
    let y = 800 - 30 - 16 * Object.keys(header).length - 14 - 18 - 15 * Math.min(rows.length, rowsPerPage) - 20;
    for (const line of footer) {
        pages.at(-1).push({ x: 50, y, text: line });
        y -= 15;
    }
    return pages;
}

/**
 * Lay out a purchase order like the standard SAP purchase order form (positions taken from a
 * real SAP S/4HANA PO PDF): title, address and labelled info block, ship-to address, and an item
 * table  Item | ID | Description | Quantity | Delivery Date / Service Period | Net Price | Net Value
 * with the price unit ('per 1 PC') below the price, schedule lines below each item and the
 * Incoterms at the end. Returns the pages for makePdf().
 *
 * @param {{po:string, created:string, items:Array<{item:string, id:string, description:string,
 *          quantity:string, date:string, price:string, per?:string, value?:string, more?:string}>,
 *          total?:string}} order  `more` = wrapped second description line
 */
export function sapFormPages({ po, created, items, total = '' }) {
    const t = [
        { x: 56.7, y: 760.6, text: `Purchase Order: ${po}`, size: 18 },
        { x: 70.9, y: 692.9, text: 'Unternehmen' },
        { x: 70.9, y: 680.1, text: 'Werk 1010 als Geschaeftspartner' },
        { x: 70.9, y: 667.4, text: 'Dietmar-Hopp-Alle 1' },
        { x: 70.9, y: 654.6, text: '69190 WALLDORF' },
        { x: 70.9, y: 641.8, text: 'GERMANY' },
    ];
    const info = [['Purchase Order:', po], ['Created on:', created], ['Contact Person:', 'Group 002'], ['Phone:', '331'],
        ['Fax:', '770 840 9000'], ['E-Mail:', 'a'], ['Supplier ID:', '0010411010'], ['VAT No.:', 'DE154512324']];
    info.forEach(([label, value], i) => {
        t.push({ x: 314.6, y: 686.9 - 14.15 * i, text: label }, { x: 413.9, y: 686.9 - 14.15 * i, text: value });
    });
    ['Ship-to Address:', 'Receiving and Sorting', 'Deer Creek', 'PALO ALTO CA  94304-1355', 'USA']
        .forEach((text, i) => t.push({ x: 56.7, y: 565 - 14.15 * i, text }));

    const head = [[59.5, 'Item'], [93.5, 'ID'], [150.2, 'Description'], [295.1, 'Quantity'],
        [343.3, 'Delivery Date /'], [440, 'Net Price'], [511.7, 'Net Value']];
    for (const [x, text] of head) t.push({ x, y: 477.9, text, size: 9 });
    t.push({ x: 342.8, y: 467.5, text: 'Service Period', size: 9 });

    let y = 452.7;
    for (const it of items) {
        // right-aligned cells end at the column's right edge (approximate Helvetica widths at 10pt)
        const width = (text) => [...text].reduce((w, ch) =>
            w + (/[\d]/.test(ch) ? 5.56 : /[.,: ]/.test(ch) ? 2.78 : /[A-Z]/.test(ch) ? 6.67 : 5), 0);
        const right = (end, text) => end - width(text);
        t.push({ x: 59.5, y, text: it.item }, { x: 93.5, y, text: it.id }, { x: 150.2, y, text: it.description },
            { x: right(331.6, it.quantity), y, text: it.quantity }, { x: 346.4, y, text: it.date },
            { x: right(479, it.price), y, text: it.price }, { x: right(552.7, it.value ?? it.price), y, text: it.value ?? it.price });
        if (it.per) t.push({ x: 439.6, y: y - 11.4, text: it.per });
        if (it.more) t.push({ x: 150.2, y: y - 11.4, text: it.more });
        t.push({ x: 263.6, y: y - 25.7, text: 'Schedule Lines:', size: 9 },
            { x: right(331.6, it.quantity), y: y - 37, text: it.quantity, size: 9 }, { x: 352.3, y: y - 37, text: it.date, size: 9 });
        y -= 55;
    }
    t.push({ x: 93.5, y, text: 'Incoterms:', size: 9 }, { x: 139.6, y, text: 'EXW (Ex Works); Berlin', size: 9 });
    t.push({ x: 382.7, y: y - 55, text: 'Total Value:' }, { x: 484.7, y: y - 55, text: total });
    t.push({ x: 453.1, y: 73.4, text: 'Test Copy', size: 30 });
    return [t];
}
