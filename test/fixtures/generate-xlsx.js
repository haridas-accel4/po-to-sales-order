// Generates the XLSX sample fixtures:  node test/fixtures/generate-xlsx.js
import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const HEADER = ['CustomerPO', 'PODate', 'DeliveryDate', 'Line', 'CustomerMaterial', 'Description', 'Quantity', 'UoM', 'UnitPrice'];
const d = (s) => new Date(`${s}T00:00:00Z`);

async function write(file, rows, header = HEADER) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('PO');
    ws.addRow(header);
    rows.forEach((r) => ws.addRow(r));
    ws.getColumn(2).numFmt = 'yyyy-mm-dd';
    ws.getColumn(3).numFmt = 'yyyy-mm-dd';
    await wb.xlsx.writeFile(path.join(dir, file));
    console.log('written', file);
}

await write('sample-po.xlsx', [
    ['PO-2027-0101', d('2027-03-01'), d('2027-03-20'), 10, 'ACME-BOLT-10', 'Hex bolt M10', 250, 'PCS', 0.25],
    ['PO-2027-0101', d('2027-03-01'), d('2027-03-20'), 20, 'ACME-NUT-10', 'Hex nut M10', 250, 'pcs', 0.1],
    ['PO-2027-0101', d('2027-03-01'), d('2027-03-20'), 30, 'ACME-WASH-10', { richText: [{ text: 'Washer ' }, { text: 'M10' }] }, { formula: '2*1.25', result: 2.5 }, 'KG', 12],
]);
await write('invalid-quantities.xlsx', [
    ['PO-2027-0102', d('2027-03-01'), d('2027-03-20'), 10, 'ACME-BOLT-10', 'Hex bolt', 'ten', 'PCS', 1],
    ['PO-2027-0102', d('2027-03-01'), d('2027-03-20'), 20, 'ACME-NUT-10', 'Hex nut', 0, 'PCS', 1],
]);
await write('invalid-missing-columns.xlsx', [['PO-1', d('2027-03-01'), 10, 'X', 1]], ['CustomerPO', 'PODate', 'Line', 'CustomerMaterial', 'Quantity']);
