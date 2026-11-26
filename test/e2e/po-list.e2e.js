/* global sap, window, document, localStorage */ // used inside browser-evaluated callbacks
/**
 * Browser tests for the purchase order list: Go, Clear, Adapt Filters, Table Settings and the
 * Settings menu, including filtering on top of server-side paging.
 *
 *   npm run test:e2e
 *
 * Starts the CAP app in-process with an in-memory database (cds.test) and drives the real SAPUI5
 * app with a locally installed Chrome/Edge (playwright-core). Requires internet access for the UI5 CDN.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
const SRV = '/odata/v4/sales-order';
const HEADER = 'CustomerPO,PODate,DeliveryDate,Line,CustomerMaterial,Description,Quantity,UoM,UnitPrice';
const VIEW = 'container-po2so.salesorder---app';
const P = VIEW + '--';
const byId = (id) => `[id="${P}${id}"]`;
const PAGE_SIZE = 2; // small server page size: the UI has to follow @odata.nextLink

describe('Purchase order list: filters and settings in the browser', { skip: !executablePath && 'no Chrome/Edge found (set CHROME_PATH)' }, () => {
    let browser; let page; const consoleErrors = [];

    const csvUpload = (po, customerId, poDate, material = 'ACME-BOLT-10') => app.post(`${SRV}/uploadPurchaseOrder`, {
        fileName: `${po}.csv`, mimeType: 'text/csv', customerId,
        content: Buffer.from(`${HEADER}\n${po},${poDate},2027-12-01,10,${material},,1,PCS,\n`).toString('base64'),
    }).then((r) => r.data);

    const model = (name, path) => page.evaluate(([v, n, p]) => sap.ui.require('sap/ui/core/Element').getElementById(v).getModel(n).getProperty(p), [VIEW, name, path]);
    const control = (id, fn, arg) => page.evaluate(([cid, f, a]) => {
        const c = sap.ui.require('sap/ui/core/Element').getElementById(cid);
        return c[f](a);
    }, [P + id, fn, arg]);
    const records = async () => (await model('records', '/records')).map((r) => r.poNumber || r.fileName);
    const selectedTab = () => control('mainTabs', 'getSelectedKey');
    const tableTitle = () => control('tableTitle', 'getText');
    const fieldShown = (id) => page.evaluate((cid) => sap.ui.require('sap/ui/core/Element').getElementById(cid).getParent().getVisible(), P + id);
    const openApp = async () => {
        await page.goto(app.url + '/sales-order/webapp/index.html');
        await page.getByText('Purchase Order Processing').waitFor({ timeout: 60000 });
        await page.waitForFunction(() => window.sap?.ui?.require?.('sap/ui/core/Element'));
        await page.waitForFunction((v) => {
            const view = sap.ui.require('sap/ui/core/Element').getElementById(v);
            return view && view.byId('poTable') && !view.byId('poTable').getBusy() && view.getModel('stats').getProperty('/processed') > 0;
        }, VIEW);
    };
    const selectTab = async (text) => { await page.locator('.sapMITBFilter', { hasText: text }).first().click(); await page.waitForTimeout(150); };
    const select = async (id, text) => {
        await page.locator(byId(id)).click();
        await page.locator('.sapMSelectList li:visible', { hasText: text }).first().click();
    };
    const go = async () => { await page.locator(byId('goButton')).click(); await page.waitForTimeout(150); };
    const clear = async () => { await page.locator(byId('clearButton')).click(); await page.waitForTimeout(150); };
    const dialog = (id) => page.locator(byId(id));
    /** The open sap.m.p13n.Popup renders as a sap.m.Dialog of its own (the Popup itself has no DOM). */
    const p13nDialog = () => page.locator('.sapMDialog.sapMDialogOpen:visible').last();
    const openDialog = async (id) => page.waitForFunction((cid) => sap.ui.require('sap/ui/core/Element').getElementById(cid)?.isOpen(), P + id);
    const closedDialog = async (id) => page.waitForFunction((cid) => !sap.ui.require('sap/ui/core/Element').getElementById(cid)?.isOpen(), P + id);
    /** Toggle the "shown" checkbox of a field in a p13n SelectionPanel. */
    const togglePanelField = (panelId, label) => page.locator(`${byId(panelId)} tr.sapMLIB`)
        .filter({ has: page.locator('bdi', { hasText: new RegExp(`^${label}$`) }) })
        .first().locator('.sapMCb').first().click();
    const storedSettings = () => page.evaluate(() => JSON.parse(localStorage.getItem('po2so.salesorder.listSettings.v1') || 'null'));

    before(async () => {
        cds.env.po2so.autoPost = false;
        // small server pages for the order list (CAP's paging handler reads the annotation on the first GET)
        const srv = Object.values(cds.services).find((s) => s.entities?.InboundOrders);
        srv.entities.InboundOrders['@cds.query.limit'] = PAGE_SIZE;

        // processed: 3 validated + 1 needs review (unmapped material); exceptions: 1 failed + the needs-review one
        await csvUpload('PO-LIST-001', 'ACME', '2027-01-15');
        await csvUpload('PO-LIST-002', 'GLOBEX', '2027-02-10', 'UNKNOWN-PART');
        await csvUpload('PO-LIST-003', 'ACME', '2027-03-05');
        await csvUpload('PO-LIST-004', 'ACME', '2027-04-20');
        await app.post(`${SRV}/uploadPurchaseOrder`, {
            fileName: 'broken-list.csv', mimeType: 'text/csv', customerId: 'ACME',
            content: readFileSync(new URL('../fixtures/invalid-missing-columns.csv', import.meta.url)).toString('base64'),
        });

        const { chromium } = await import('playwright-core');
        browser = await chromium.launch({ executablePath });
        page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('console', (m) => { if (m.type() === 'error' && !/Component-preload|unload is not allowed|404 \(Not Found\)|40[09] \(/.test(m.text())) consoleErrors.push(m.text()); });
        page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));
        await page.goto(app.url + '/sales-order/webapp/index.html');
        await page.evaluate(() => localStorage.clear());
        await openApp();
    });
    after(async () => {
        await browser?.close();
    });

    test('the backend pages the order list and the UI loads every page', async () => {
        const first = (await app.get(`${SRV}/InboundOrders?$select=ID`)).data;
        assert.equal(first.value.length, PAGE_SIZE);
        assert.ok(first['@odata.nextLink'], 'server-side paging is active');
        assert.equal((await model('records', '/records')).length, 5, 'all pages are loaded into the list');
        assert.equal(await model('stats', '/processed'), 4);
        assert.equal(await model('stats', '/exceptions'), 2);
    });

    test('Go on the PO Upload tab applies one filter and shows the results in Processed POs', async () => {
        assert.equal(await selectedTab(), 'upload');
        await page.locator(`${byId('filterPoNumber')} input`).fill('PO-LIST-002');
        await go();
        assert.equal(await selectedTab(), 'processed');
        assert.deepEqual(await records(), ['PO-LIST-002']);
        assert.equal(await tableTitle(), 'Processed Purchase Orders (1)');
        await page.waitForFunction((sel) => document.querySelector(sel)?.innerText.includes('PO-LIST-002'), byId('poTable'));
        assert.equal(await page.locator(`${byId('poTable')} tbody tr.sapMLIB`).count(), 1);
    });

    test('Go applies several filters together (customer, file type, date range)', async () => {
        await clear();
        await page.locator(`${byId('filterCustomer')} input`).fill('acme');
        await select('filterFileType', 'CSV');
        await page.locator(`${byId('filterDateFrom')} input`).fill('Feb 1, 2027');
        await page.locator(`${byId('filterDateTo')} input`).fill('Mar 31, 2027');
        await page.locator(`${byId('filterDateTo')} input`).press('Tab');
        await go();
        assert.deepEqual(await model('filters', '/'), {
            search: '', poNumber: '', customer: 'acme', status: '', fileType: 'CSV', dateFrom: '2027-02-01', dateTo: '2027-03-31',
        });
        assert.deepEqual(await records(), ['PO-LIST-003']);

        // a status filter on top narrows further; Enter in a text field works like Go
        await select('filterStatus', 'Needs Review');
        await page.locator(`${byId('filterPoNumber')} input`).press('Enter');
        assert.deepEqual(await records(), []);
    });

    test('Clear resets every filter field and restores the complete list', async () => {
        await page.locator(`${byId('poSearch')} input`).fill('list');
        await clear();
        assert.deepEqual(await model('filters', '/'), {
            search: '', poNumber: '', customer: '', status: '', fileType: '', dateFrom: '', dateTo: '',
        });
        for (const id of ['filterPoNumber', 'filterCustomer', 'filterDateFrom', 'filterDateTo']) {
            assert.equal(await page.locator(`${byId(id)} input`).inputValue(), '', id);
        }
        assert.equal(await page.locator(`${byId('poSearch')} input`).inputValue(), '');
        assert.equal(await control('filterStatus', 'getSelectedKey'), '');
        assert.equal(await control('filterFileType', 'getSelectedKey'), '');
        assert.equal((await records()).length, 4, 'all processed orders');
        assert.equal(await tableTitle(), 'Processed Purchase Orders (4)');
    });

    test('an invalid date blocks Go with a message and Clear removes it', async () => {
        await page.locator(`${byId('filterDateFrom')} input`).fill('not a date');
        await page.locator(`${byId('filterDateFrom')} input`).press('Tab');
        assert.equal(await control('filterDateFrom', 'getValueState'), 'Error');
        await page.locator(`${byId('filterPoNumber')} input`).fill('PO-LIST-001');
        await go();
        await page.waitForFunction(() => document.querySelector('.sapMMessageToast')?.innerText.includes("Enter a valid date for 'PO Date From'"));
        assert.equal((await records()).length, 4, 'list unchanged');
        await clear();
        assert.equal(await page.locator(`${byId('filterDateFrom')} input`).inputValue(), '');
        assert.equal(await control('filterDateFrom', 'getValueState'), 'None');
    });

    test('a Failed status filter on the PO Upload tab shows the results in Exceptions', async () => {
        await selectTab('PO Upload');
        await select('filterStatus', 'Failed');
        await go();
        assert.equal(await selectedTab(), 'exceptions');
        assert.deepEqual(await records(), ['broken-list.csv']);
        await clear();
        assert.equal((await records()).length, 2, 'all exceptions');
    });

    test('filters stay applied when switching tabs and on refresh', async () => {
        await page.locator(`${byId('filterCustomer')} input`).fill('globex');
        await go();
        assert.deepEqual(await records(), ['PO-LIST-002']); // exceptions tab
        await selectTab('Processed POs');
        assert.deepEqual(await records(), ['PO-LIST-002']);
        await page.locator('button[title="Refresh"]').first().click();
        await page.waitForFunction(() => document.querySelector('.sapMMessageToast')?.innerText.includes('Records refreshed'));
        assert.deepEqual(await records(), ['PO-LIST-002']);
        await clear();
    });

    test('Adapt Filters hides an optional filter field, clears its value and is remembered', async () => {
        await page.locator(`${byId('filterCustomer')} input`).fill('globex');
        await go();
        assert.deepEqual(await records(), ['PO-LIST-002']);

        await page.locator(byId('adaptFiltersButton')).click();
        await openDialog('adaptFiltersDialog');
        const labels = await page.locator(`${byId('adaptFiltersPanel')} tr.sapMLIB`).allInnerTexts();
        assert.deepEqual(labels.map((l) => l.trim()).filter(Boolean),
            ['Purchase Order', 'Customer', 'Status', 'File Type', 'PO Date From', 'PO Date To']);
        await togglePanelField('adaptFiltersPanel', 'Customer');
        await p13nDialog().getByRole('button', { name: 'OK' }).click();
        await closedDialog('adaptFiltersDialog');

        assert.equal(await fieldShown('filterCustomer'), false, 'Customer filter hidden');
        assert.equal(await fieldShown('filterPoNumber'), true, 'other filters still shown');
        assert.equal(await model('filters', '/customer'), '', 'hidden filter no longer filters');
        assert.equal((await records()).length, 4);
        assert.equal((await storedSettings()).filterVisible.customer, false);

        // Cancel discards changes
        await page.locator(byId('adaptFiltersButton')).click();
        await openDialog('adaptFiltersDialog');
        await togglePanelField('adaptFiltersPanel', 'Status');
        await p13nDialog().getByRole('button', { name: 'Cancel' }).click();
        await closedDialog('adaptFiltersDialog');
        assert.equal(await fieldShown('filterStatus'), true);

        // remembered after a reload
        await openApp();
        assert.equal(await fieldShown('filterCustomer'), false);

        // and selectable again
        await page.locator(byId('adaptFiltersButton')).click();
        await openDialog('adaptFiltersDialog');
        await togglePanelField('adaptFiltersPanel', 'Customer');
        await p13nDialog().getByRole('button', { name: 'OK' }).click();
        await closedDialog('adaptFiltersDialog');
        assert.equal(await fieldShown('filterCustomer'), true);
    });

    test('Table Settings shows / hides columns and sorts the list', async () => {
        await selectTab('Processed POs');
        await page.locator(byId('tableSettingsButton')).click();
        await openDialog('tableSettingsDialog');
        await togglePanelField('tableColumnsPanel', 'Source');
        // sort descending by Purchase Order through the Sort panel's data (same path as its UI)
        await page.evaluate((pid) => {
            const panel = sap.ui.require('sap/ui/core/Element').getElementById(pid);
            panel.setP13nData(panel.getP13nData().map((i) => ({ ...i, sorted: i.name === 'poNumber', descending: i.name === 'poNumber' }))
                .sort((a, b) => Number(b.sorted) - Number(a.sorted)));
        }, P + 'tableSortPanel');
        await p13nDialog().getByRole('button', { name: 'OK' }).click();
        await closedDialog('tableSettingsDialog');

        const columns = await page.evaluate((tid) => sap.ui.require('sap/ui/core/Element').getElementById(tid).getColumns()
            .map((c) => `${c.getHeader().getText()}:${c.getVisible()}`), P + 'poTable');
        assert.ok(columns.includes('Source:false'));
        assert.ok(columns.includes('Purchase Order:true'));
        assert.deepEqual(await records(), ['PO-LIST-004', 'PO-LIST-003', 'PO-LIST-002', 'PO-LIST-001']);
        assert.deepEqual((await storedSettings()).sort, [{ key: 'poNumber', descending: true }]);

        // sorting combines with filters
        await page.locator(`${byId('filterCustomer')} input`).fill('acme');
        await go();
        assert.deepEqual(await records(), ['PO-LIST-004', 'PO-LIST-003', 'PO-LIST-001']);
        await clear();
    });

    test('Settings menu opens the existing configuration and restores the default view', async () => {
        await page.locator(byId('settingsButton')).click();
        const items = page.locator('.sapMMenu:visible .sapMMenuItem, .sapUiMnu:visible .sapUiMnuItm');
        await items.first().waitFor();
        const texts = (await items.allInnerTexts()).map((t) => t.trim());
        assert.deepEqual(texts, ['Adapt Filters', 'Table Settings', 'Gmail Intake', 'Manage Mappings', 'Restore Default View']);

        await items.filter({ hasText: 'Table Settings' }).first().click();
        await openDialog('tableSettingsDialog');
        await p13nDialog().getByRole('button', { name: 'Cancel' }).click();
        await closedDialog('tableSettingsDialog');

        await page.locator(byId('settingsButton')).click();
        await items.filter({ hasText: 'Gmail Intake' }).first().click();
        await openDialog('gmailDialog');
        await dialog('gmailDialog').getByRole('button', { name: 'Close' }).click();
        await closedDialog('gmailDialog');

        await page.locator(byId('settingsButton')).click();
        await items.filter({ hasText: 'Restore Default View' }).first().click();
        await page.waitForFunction(() => document.querySelector('.sapMMessageToast')?.innerText.includes('Default filter fields, columns and sorting restored'));
        const columns = await page.evaluate((tid) => sap.ui.require('sap/ui/core/Element').getElementById(tid).getColumns()
            .map((c) => c.getVisible()), P + 'poTable');
        assert.ok(columns.every(Boolean), 'all columns shown again');
        assert.deepEqual(await model('listSettings', '/sort'), [], 'sorting reset to the backend order');
        assert.equal((await records()).length, 4);
        assert.equal(await storedSettings(), null, 'stored preferences removed');
    });

    test('existing workflows: a filtered row still opens the review dialog; no browser errors', async () => {
        await page.locator(`${byId('filterPoNumber')} input`).fill('PO-LIST-002');
        await go();
        await page.locator(`${byId('poTable')} tr`, { hasText: 'PO-LIST-002' }).first().click();
        await page.waitForFunction((cid) => {
            const d = sap.ui.require('sap/ui/core/Element').getElementById(cid);
            return d && d.isOpen() && !d.getBusy();
        }, P + 'reviewDialog');
        assert.equal(await model('review', '/order/customerPoNumber'), 'PO-LIST-002');
        await dialog('reviewDialog').getByRole('button', { name: 'Close' }).click();
        await clear();
        assert.deepEqual(consoleErrors, []);
    });
});
