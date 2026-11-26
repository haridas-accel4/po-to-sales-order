/* global sap, window, document */ // used inside browser-evaluated callbacks
/**
 * Browser tests for mapping maintenance, bulk revalidation and "Add Mapping" in the review dialog.
 *
 *   npm run test:e2e
 *
 * Starts the CAP app in-process with an in-memory database (cds.test) and drives the
 * real SAPUI5 app with a locally installed Chrome/Edge (playwright-core, no browser download).
 * Set CHROME_PATH to use another browser binary. Requires internet access for the UI5 CDN.
 * Skipped automatically when no browser is found.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cds from '@sap/cds';

const BROWSERS = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = BROWSERS.find((p) => existsSync(p));

const app = cds.test(fileURLToPath(new URL('../..', import.meta.url)), '--in-memory');
// These tests cover intake, review and validation: keep orders open instead of posting them to SAP
// (posting is covered in test/api/sales-order-posting.test.js).
before(() => { cds.env.po2so.autoPost = false; });
const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const VIEW = 'container-po2so.salesorder---app';
const P = VIEW + '--';
const byId = (id) => `[id="${P}${id}"]`;

describe('Mapping maintenance in the browser', { skip: !executablePath && 'no Chrome/Edge found (set CHROME_PATH)' }, () => {
    let browser; let page; const consoleErrors = [];

    const upload = async (po, rows) => (await app.post(`${SRV}/uploadPurchaseOrder`, {
        fileName: `${po}.csv`, mimeType: 'text/csv', customerId: 'ACME',
        content: Buffer.from(`${HEADER}\n${rows.map((r) => [po, '2027-01-15', '2027-02-01', ...r].join(',')).join('\n')}\n`).toString('base64'),
    })).data;
    const order = async (ID) => (await app.get(`${SRV}/InboundOrders(${ID})?$expand=items,issues`)).data;
    const model = (name, path) => page.evaluate(([v, n, p]) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel(n).getProperty(p), [VIEW, name, path]);
    const idle = (id) => page.waitForFunction((cid) => {
        const d = sap.ui.require('sap/ui/core/Element').getElementById(cid);
        return d && d.isOpen() && !d.getBusy();
    }, P + id);
    const closed = (id) => page.waitForFunction((cid) => {
        const d = sap.ui.require('sap/ui/core/Element').getElementById(cid);
        return !d || !d.isOpen();
    }, P + id);
    const mappingTab = async (text) => { await page.locator(`${byId('mappingTabs')} .sapMITBFilter`, { hasText: text }).first().click(); await page.waitForTimeout(200); };
    const selectRow = async (table, text) => {
        await page.locator(`${byId(table)} tr.sapMLIB`, { hasText: text }).first().locator('.sapMRb, .sapMRbB').first().click();
        await page.waitForTimeout(150);
    };
    const fill = (id, value) => page.locator(`${byId(id)} input`).fill(value);
    const toolbarButton = (tab, text) => page.locator(`${byId('mappingTabs')} .sapMITBContent button:visible`, { hasText: new RegExp(`^${text}$`) }).first();
    const messageBoxText = async () => (await page.locator('.sapMMessageBox').last().innerText()).replace(/\s+/g, ' ');
    const closeMessageBox = () => page.locator('.sapMMessageBox').last().locator('footer button:visible, .sapMDialogFooter button:visible, button.sapMBtn:visible').last().click();

    before(async () => {
        const { chromium } = await import('playwright-core');
        browser = await chromium.launch({ executablePath });
        page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('console', (m) => { if (m.type() === 'error' && !/Component-preload|unload is not allowed|404 \(Not Found\)|40[09] \(/.test(m.text())) consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));
        await page.goto(app.url + '/sales-order/webapp/index.html');
        await page.getByText('Purchase Order Processing').waitFor({ timeout: 60000 });
        await page.waitForFunction(() => window.sap?.ui?.require?.('sap/ui/core/Element'));
    });
    after(async () => { await browser?.close(); });

    test('opens Manage Mappings with the three tabs and current data', async () => {
        await page.locator(byId('manageMappingsButton')).click();
        await idle('manageMappingsDialog');
        assert.equal((await model('mappings', '/customers/rows')).length, 3);
        assert.equal((await model('mappings', '/materials/rows')).length, 4);
        assert.equal((await model('mappings', '/uoms/rows')).length, 5);
        for (const tab of ['Customers', 'Material Mappings', 'UoM Mappings']) {
            assert.equal(await page.locator(`${byId('mappingTabs')} .sapMITBFilter`, { hasText: tab }).count(), 1, tab);
        }
    });

    test('adds a UoM mapping and rejects a case-variant duplicate with a field error', async () => {
        await mappingTab('UoM Mappings');
        await toolbarButton('uoms', 'Add').click();
        await idle('mappingEditDialog');
        await fill('mapExternalUom', 'TUB');
        await fill('mapSapUnit', 'TB');
        await page.locator(byId('mappingSaveButton')).click();
        await closed('mappingEditDialog');
        await page.waitForFunction(() => document.querySelector('.sapMMessageToast')?.innerText.includes('saved'));
        assert.ok((await model('mappings', '/uoms/rows')).some((r) => r.externalUom === 'TUB' && r.sapUnit === 'TB'));

        await toolbarButton('uoms', 'Add').click();
        await idle('mappingEditDialog');
        await fill('mapExternalUom', 'pcs');
        await fill('mapSapUnit', 'XX');
        await page.locator(byId('mappingSaveButton')).click();
        await page.locator('.sapMMessageBox').waitFor();
        assert.match(await messageBoxText(), /Conflict.*'pcs' conflicts with the existing uom mapping 'PCS'/);
        await closeMessageBox();
        assert.equal(await model('mappingEdit', '/vs/externalUom') !== undefined, true, 'External UoM field is marked');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await closed('mappingEditDialog');
        assert.equal((await order(await upload('PO-E2E-UOM', [[10, 'ACME-BOLT-10', '', 1, 'pcs', '']]).then((o) => o.ID))).items[0].sapUom, 'PC');
    });

    test('edits a material mapping, then deactivates and re-activates it', async () => {
        await mappingTab('Material Mappings');
        await selectRow('materialsTable', 'ACME-WASH-10');
        await toolbarButton('materials', 'Edit').click();
        await idle('mappingEditDialog');
        assert.equal(await page.locator(`${byId('mapCustomerMaterial')} input`).isEditable(), false, 'key is read-only when editing');
        await fill('mapMaterial', 'TG13B');
        await page.locator(byId('mappingSaveButton')).click();
        await closed('mappingEditDialog');
        await page.waitForTimeout(300);
        assert.equal((await model('mappings', '/materials/rows')).find((r) => r.customerMaterial === 'ACME-WASH-10').material, 'TG13B');

        await selectRow('materialsTable', 'ACME-WASH-10');
        await toolbarButton('materials', 'Deactivate').click();
        await page.locator('.sapMMessageBox').waitFor();
        await page.locator('.sapMMessageBox button', { hasText: 'OK' }).click();
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('mappings')
            .getProperty('/materials/rows').find((r) => r.customerMaterial === 'ACME-WASH-10').active === false, VIEW);
        await selectRow('materialsTable', 'ACME-WASH-10');
        await toolbarButton('materials', 'Activate').click();
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('mappings')
            .getProperty('/materials/rows').find((r) => r.customerMaterial === 'ACME-WASH-10').active === true, VIEW);
        await app.patch(`${SRV}/MaterialMappings(soldToParty='0010100001',customerMaterial='ACME-WASH-10')`, { material: 'TG13' });
    });

    test('customer edit that would orphan material mappings shows the backend error', async () => {
        await mappingTab('Customers');
        await selectRow('customersTable', 'GLOBEX');
        await toolbarButton('customers', 'Edit').click();
        await idle('mappingEditDialog');
        await fill('mapCustomerSoldTo', '0010100099');
        await page.locator(byId('mappingSaveButton')).click();
        await page.locator('.sapMMessageBox').waitFor();
        assert.match(await messageBoxText(), /Sold-to party cannot change from 0010100002 to 0010100099/);
        await closeMessageBox();
        await page.getByRole('button', { name: 'Cancel' }).click();
        await closed('mappingEditDialog');
        assert.equal((await app.get(`${SRV}/Customers('GLOBEX')`)).data.soldToParty, '0010100002');
    });

    test('Revalidate Open Orders updates multiple affected orders', async () => {
        const a = await upload('PO-E2E-BULK-A', [[10, 'E2E-BULK', '', 1, 'PCS', '']]);
        const b = await upload('PO-E2E-BULK-B', [[10, 'E2E-BULK', '', 2, 'PCS', '']]);
        assert.deepEqual([a.status, b.status], ['NEEDS_REVIEW', 'NEEDS_REVIEW']);

        await mappingTab('Material Mappings');
        await toolbarButton('materials', 'Add').click();
        await idle('mappingEditDialog');
        await page.locator(`${byId('mapMaterialSoldTo')}`).click();
        await page.locator('.sapMSelectList li:visible', { hasText: '0010100001' }).first().click();
        await fill('mapCustomerMaterial', 'E2E-BULK');
        await fill('mapMaterial', 'TG11');
        await page.locator(byId('mappingSaveButton')).click();
        await closed('mappingEditDialog');

        await page.locator(byId('revalidateOpenOrdersButton')).click();
        await page.locator('.sapMMessageBox').waitFor();
        const text = await messageBoxText();
        assert.match(text, /Checked \d+ open order\(s\)/);
        assert.match(text, /status change/);
        await closeMessageBox();
        assert.equal((await order(a.ID)).status, 'VALIDATED');
        assert.equal((await order(b.ID)).status, 'VALIDATED');

        await page.locator(byId('manageMappingsDialog')).getByRole('button', { name: 'Close' }).click();
        await closed('manageMappingsDialog');
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('stats').getProperty('/processed') > 0, VIEW);
    });

    test('Add Mapping from the review dialog creates the mapping and revalidates the order', async () => {
        const up = await upload('PO-E2E-DIALOG', [[10, 'E2E-NEW-PART', 'Gadget', 4, 'TUB', ''], [20, 'ACME-NUT-10', '', 1, 'DRUM', '']]);
        assert.equal(up.status, 'NEEDS_REVIEW');
        await page.locator('button[title="Refresh"]').first().click();
        await page.locator('.sapMITBFilter', { hasText: 'Exceptions' }).first().click();
        await page.locator(`${byId('poTable')} tr`, { hasText: 'PO-E2E-DIALOG' }).first().click();
        await idle('reviewDialog');

        const issues = await model('review', '/issues');
        assert.deepEqual(issues.map((i) => `${i.code}:${i.canAddMapping}`).sort(), ['MATERIAL_UNMAPPED:true', 'UOM_UNMAPPED:true']);

        // material issue: key fields prefilled and locked
        await page.locator(`${byId('reviewIssuesTable')} tr`, { hasText: 'MATERIAL_UNMAPPED' }).getByRole('button', { name: 'Add Mapping' }).click();
        await idle('mappingEditDialog');
        assert.equal(await page.locator(`${byId('mapCustomerMaterial')} input`).inputValue(), 'E2E-NEW-PART');
        assert.equal(await page.locator(`${byId('mapCustomerMaterial')} input`).isEditable(), false);
        assert.equal(await model('mappingEdit', '/draft/soldToParty'), '0010100001');
        await fill('mapMaterial', 'TG15');
        await page.locator(byId('mappingSaveButton')).click();
        await closed('mappingEditDialog');
        await page.waitForFunction((v) => !sap.ui.require('sap/ui/core/Element').getElementById(v + '--reviewDialog').getBusy()
            && !sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('review').getProperty('/issues').some((i) => i.code === 'MATERIAL_UNMAPPED'), VIEW);
        assert.deepEqual((await model('review', '/issues')).map((i) => i.code), ['UOM_UNMAPPED']);
        assert.equal((await model('review', '/order/status')), 'NEEDS_REVIEW');

        // UoM issue
        await page.locator(`${byId('reviewIssuesTable')} tr`, { hasText: 'UOM_UNMAPPED' }).getByRole('button', { name: 'Add Mapping' }).click();
        await idle('mappingEditDialog');
        assert.equal(await page.locator(`${byId('mapExternalUom')} input`).inputValue(), 'DRUM');
        await fill('mapSapUnit', 'DR');
        await page.locator(byId('mappingSaveButton')).click();
        await closed('mappingEditDialog');
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('review').getProperty('/order/status') === 'VALIDATED', VIEW);
        assert.deepEqual(await model('review', '/issues'), []);
        const items = (await order(up.ID)).items.sort((x, y) => x.lineNumber - y.lineNumber);
        assert.deepEqual(items.map((i) => [i.material, i.sapUom]), [['TG15', 'TB'], ['TG12', 'DR']]);
        await page.locator(byId('reviewDialog')).getByRole('button', { name: 'Close' }).click();
        await closed('reviewDialog');
    });

    test('existing upload and review correction still work', async () => {
        await page.locator('.sapMITBFilter', { hasText: 'PO Upload' }).first().click();
        await page.locator(byId('uploadCustomer')).click();
        await page.locator('.sapMSelectList li:visible', { hasText: 'ACME Industries Ltd.' }).first().click();
        await page.locator(`${byId('poFileUploader')} input[type=file]`).setInputFiles(fileURLToPath(new URL('../fixtures/sample-po.xlsx', import.meta.url)));
        await page.locator(byId('uploadButton')).click();
        await page.waitForFunction((id) => sap.ui.require('sap/ui/core/Element').getElementById(id).getVisible(), P + 'uploadResult');
        assert.match(await page.evaluate((id) => sap.ui.require('sap/ui/core/Element').getElementById(id).getText(), P + 'uploadResult'), /Status: Validated/);

        await page.locator('.sapMITBFilter', { hasText: 'Processed POs' }).first().click();
        await page.locator(`${byId('poTable')} tr`, { hasText: 'PO-2027-0101' }).first().click();
        await idle('reviewDialog');
        const qty = page.locator(`${byId('reviewItemsTable')} tbody tr.sapMLIB`).first().locator('input').nth(2);
        await qty.fill('0');
        await page.locator(byId('reviewSaveButton')).click();
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('review').getProperty('/order/status') === 'NEEDS_REVIEW', VIEW);
        await qty.fill('250');
        await page.locator(byId('reviewSaveButton')).click();
        await page.waitForFunction((v) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel('review').getProperty('/order/status') === 'VALIDATED', VIEW);
        await page.locator(byId('reviewDialog')).getByRole('button', { name: 'Close' }).click();
    });

    test('no unexpected console errors', () => {
        assert.deepEqual(consoleErrors, []);
    });
});
