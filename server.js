import fs from 'node:fs';
import path from 'node:path';
import cds from '@sap/cds';
import { registerGmailRoutes } from './srv/lib/gmail/routes.js';
import { startPolling, stopPolling } from './srv/lib/gmail/index.js';

/**
 * Custom CAP server bootstrap (cds serve / cds watch use it automatically):
 *   - loads Gmail settings from a local .env file (not in Git)
 *   - adds the Gmail OAuth routes to CAP's Express app
 *   - starts / stops automatic Gmail polling with the server
 *
 * Under `node --test` nothing is loaded from .env and no polling starts, so automated
 * tests can never reach a real mailbox.
 */
const underTest = !!process.env.NODE_TEST_CONTEXT;

const envFile = path.join(cds.root, '.env');
if (!underTest && fs.existsSync(envFile)) process.loadEnvFile(envFile); // existing variables win

cds.on('bootstrap', (app) => registerGmailRoutes(app));
if (!underTest) cds.on('served', () => startPolling());
cds.on('shutdown', () => stopPolling());

export default cds.server;
