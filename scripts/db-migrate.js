/**
 * Additive, non-destructive migration of the local SQLite database (db.sqlite) to the
 * current CDS model - an alternative to `cds deploy`, which drops and re-creates tables.
 *
 *   npm run db:migrate            back up, then apply
 *   npm run db:migrate -- --dry-run   only show what would change
 *   npm run db:migrate -- --db <file> use another SQLite file (e.g. a copy)
 *
 * What it does:
 *   - compiles the model (same SQL as `cds deploy`) into a scratch in-memory database
 *   - creates tables that do not exist yet
 *   - adds columns that are missing in existing tables (nullable or with a default only)
 *   - re-creates views whose definition changed (views hold no data)
 * What it never does: drop or alter existing tables or columns, delete or rewrite data.
 * Before any change the database is copied with VACUUM INTO db.backup-<timestamp>.sqlite.
 * All changes run in one transaction.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import cds from '@sap/cds';

const dryRun = process.argv.includes('--dry-run');
const root = path.resolve(import.meta.dirname, '..');
cds.root = root;

const dbArg = process.argv.indexOf('--db'); // e.g. --db copy.sqlite to try it on a copy first
const url = (dbArg > 0 && process.argv[dbArg + 1]) || cds.env.requires.db?.credentials?.url || cds.env.requires.db?.credentials?.database;
if (!url || url === ':memory:') {
    console.log('No persistent SQLite database configured (cds.requires.db.[development]); nothing to migrate.');
    process.exit(0);
}
const dbFile = path.resolve(root, url);
if (!fs.existsSync(dbFile)) {
    console.log(`${dbFile} does not exist yet. Create it with: npm run deploy:local`);
    process.exit(0);
}

const csn = await cds.load('*');
const statements = [].concat(cds.compile.to.sql(csn, { dialect: 'sqlite' })).map((s) => s.trim().replace(/;$/, ''));
const nameOf = (stmt) => /^CREATE\s+(TABLE|VIEW)\s+("?)([\w.]+)\2/i.exec(stmt);

// reference schema: the compiled model applied to an empty database
const ref = new DatabaseSync(':memory:');
for (const s of statements) ref.exec(s);

const target = new DatabaseSync(dbFile);
const objects = new Map(target.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => [r.name, r]));
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info("${table}")`).all();

const plan = [];
const problems = [];
const notes = [];

for (const stmt of statements) {
    const m = nameOf(stmt);
    if (!m) continue;
    const [, kind, , name] = m;
    const existing = objects.get(name);
    if (kind.toUpperCase() === 'TABLE') {
        if (!existing) {
            plan.push({ description: `create table ${name}`, sql: stmt });
            continue;
        }
        const have = new Set(columnsOf(target, name).map((c) => c.name));
        const want = columnsOf(ref, name);
        for (const col of want.filter((c) => !have.has(c.name))) {
            if (col.notnull && col.dflt_value === null) {
                problems.push(`${name}.${col.name} is NOT NULL without default and cannot be added to existing rows`);
                continue;
            }
            const dflt = col.dflt_value !== null ? ` DEFAULT ${col.dflt_value}` : '';
            plan.push({ description: `add column ${name}.${col.name}`, sql: `ALTER TABLE ${name} ADD COLUMN ${col.name} ${col.type}${col.notnull ? ' NOT NULL' : ''}${dflt}` });
        }
        const extra = [...have].filter((c) => !want.some((w) => w.name === c));
        if (extra.length) notes.push(`${name}: column(s) ${extra.join(', ')} no longer in the model - kept`);
    } else if (!existing || existing.sql.trim() !== stmt) {
        plan.push({ description: `${existing ? 're-create' : 'create'} view ${name}`, sql: stmt, view: name, replace: !!existing });
    }
}
const modelNames = new Set(statements.map((s) => nameOf(s)?.[3]).filter(Boolean));
for (const [name, o] of objects) {
    if (!modelNames.has(name) && !name.startsWith('sqlite_')) notes.push(`${o.type} ${name} is not in the model - kept`);
}

console.log(`Database: ${dbFile}`);
notes.forEach((n) => console.log(`  note: ${n}`));
if (problems.length) {
    problems.forEach((p) => console.error(`  BLOCKED: ${p}`));
    console.error('Nothing was changed.');
    process.exit(1);
}
if (!plan.length) {
    console.log('Schema is up to date - nothing to do.');
    process.exit(0);
}
plan.forEach((p) => console.log(`  ${dryRun ? 'would ' : ''}${p.description}`));
if (dryRun) process.exit(0);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(path.dirname(dbFile), `${path.basename(dbFile, '.sqlite')}.backup-${stamp}.sqlite`);
target.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`Backup written: ${backup}`);

// views first dropped (they may depend on each other), then tables / columns, then views created
target.exec('BEGIN IMMEDIATE');
try {
    for (const p of plan.filter((x) => x.view && x.replace)) target.exec(`DROP VIEW IF EXISTS ${p.view}`);
    for (const p of plan.filter((x) => !x.view)) target.exec(p.sql);
    for (const p of plan.filter((x) => x.view)) target.exec(p.sql);
    target.exec('COMMIT');
} catch (e) {
    target.exec('ROLLBACK');
    console.error(`Migration failed and was rolled back: ${e.message}`);
    process.exit(1);
}
console.log(`Applied ${plan.length} change(s).`);
