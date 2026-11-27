import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import cds from '@sap/cds';
import { applySapCredentialsFromEnv, sapConnectionInfo } from '../../srv/lib/sap-connection.js';

const URL = 'https://my000000-api.s4hana.cloud.sap/sap/opu/odata/sap/API_SALES_ORDER_SRV';

describe('SAP connection settings', () => {
    const requires = () => cds.env.requires.API_SALES_ORDER_SRV;
    const original = structuredClone(requires().credentials);
    afterEach(() => {
        if (original === undefined) delete requires().credentials;
        else requires().credentials = structuredClone(original);
    });

    test('without S4_SALES_ORDER_API_URL nothing changes and the mock is used', () => {
        assert.equal(applySapCredentialsFromEnv({ S4_USER: 'U', S4_PASSWORD: 'P' }), false);
        assert.equal(applySapCredentialsFromEnv({ S4_SALES_ORDER_API_URL: '  ' }), false);
        assert.equal(sapConnectionInfo().mode, 'mock');
    });

    test('URL, user and password become basic-auth credentials (trailing slash removed)', () => {
        assert.equal(applySapCredentialsFromEnv({ S4_SALES_ORDER_API_URL: `${URL}/`, S4_USER: 'BTP_USER', S4_PASSWORD: '{#a$b<' }), true);
        assert.deepEqual(requires().credentials, { url: URL, username: 'BTP_USER', password: '{#a$b<' });
        assert.deepEqual(sapConnectionInfo(), { mode: 'remote', target: URL, user: 'BTP_USER' });
    });

    test('URL without user sends no credentials', () => {
        applySapCredentialsFromEnv({ S4_SALES_ORDER_API_URL: URL });
        assert.deepEqual(requires().credentials, { url: URL });
    });

    test('a BTP destination is reported as destination mode', () => {
        requires().credentials = { destination: 'S4HC_SALES', path: '/sap/opu/odata/sap/API_SALES_ORDER_SRV' };
        assert.deepEqual(sapConnectionInfo(), { mode: 'destination', target: 'S4HC_SALES', user: null });
    });
});
