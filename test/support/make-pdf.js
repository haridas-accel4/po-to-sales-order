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
