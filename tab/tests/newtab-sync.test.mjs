import './web-locks.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test, after } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const output = mkdtempSync(join(tmpdir(), 'tmarks-sync-tests-'));
after(() => rmSync(output, { recursive: true, force: true }));
async function bundle(source, filename) {
  const outfile = join(output, filename);
  await build({ entryPoints: [source], bundle: true, outfile, platform: 'node', format: 'esm',
    alias: { '@': join(root, 'src') }, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const api = await bundle(resolve(root, '../tmarks/functions/api/tab/newtab/sync.ts'), 'api.mjs');
const recovery = await bundle(join(root, 'src/newtab/services/cloud-sync.ts'), 'recovery.mjs');

function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE bookmarks (id TEXT PRIMARY KEY, user_id TEXT, is_pinned INTEGER, pin_order INTEGER);
    INSERT INTO users VALUES ('owner'), ('other');`);
  const migration = readFileSync(resolve(root, '../tmarks/migrations/0100_d1_console.sql'), 'utf8');
  sql.exec(migration.split('ALTER TABLE bookmarks')[0]);
  const DB = {
    prepare(query) {
      return { bind(...params) {
        return { query, params,
          async all() { return { results: sql.prepare(query).all(...params) }; },
          async run() { return sql.prepare(query).run(...params); },
        };
      } };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const result = statements.map(s => sql.prepare(s.query).run(...s.params)); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    },
  };
  return { sql, DB };
}
const get = api.onRequestGet.at(-1);
const post = api.onRequestPost.at(-1);
const context = (DB, body) => ({ env: { DB }, data: { user_id: 'owner' },
  request: new Request('https://example.com/api/tab/newtab/sync', {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }),
});
function seed(sql) {
  sql.exec(`INSERT INTO newtab_shortcuts (id,user_id,title,url,position) VALUES
    ('s1','owner','First','https://first.test',0), ('private','other','Private','https://private.test',0);
    INSERT INTO newtab_grid_items (id,user_id,type,shortcut_title,shortcut_url,position) VALUES
    ('g1','owner','shortcut','Grid only','https://grid.test',1),
    ('g2','owner','shortcut','Duplicate','https://first.test',2),
    ('bad','owner','shortcut','Unsafe','javascript:alert(1)',3);`);
}

test('recovers both detail tables with no groups and excludes unsafe URLs and other accounts', async () => {
  const { sql, DB } = database(); seed(sql);
  const response = await get(context(DB));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.recovery_version, 1);
  assert.deepEqual(data.shortcuts.map(s => s.url), ['https://first.test', 'https://grid.test']);
  assert.ok(data.shortcuts.every(s => s.groupId === 'home'));
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_groups').get().n, 0);
  sql.close();
});

test('empty legacy upload preserves cloud details and groups', async () => {
  const { sql, DB } = database(); seed(sql);
  sql.exec("INSERT INTO newtab_groups (id,user_id,name) VALUES ('existing','owner','Keep')");
  const response = await post(context(DB, { groups: [], shortcuts: [], gridItems: [] }));
  assert.equal(response.status, 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_shortcuts').get().n, 2);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_grid_items').get().n, 3);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_groups').get().n, 1);
  sql.close();
});

test('incremental backup preserves absent rows and account isolation, and repeats safely', async () => {
  const { sql, DB } = database(); seed(sql);
  const body = { shortcuts: [
    { id: 's2', title: 'New', url: 'https://new.test', position: 0 },
    { id: 'private', title: 'Hijack', url: 'https://wrong.test', position: 1 },
  ] };
  assert.equal((await post(context(DB, body))).status, 200);
  assert.equal((await post(context(DB, body))).status, 200);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_shortcuts').get().n, 3);
  assert.equal(sql.prepare("SELECT url FROM newtab_shortcuts WHERE id='private'").get().url, 'https://private.test');
  assert.equal(sql.prepare("SELECT url FROM newtab_shortcuts WHERE id='s1'").get().url, 'https://first.test');
  sql.close();
});

test('validates the entire upload before writing any row', async () => {
  const { sql, DB } = database(); seed(sql);
  const response = await post(context(DB, { shortcuts: [
    { id: 'new', title: 'New', url: 'https://new.test', position: 0 },
    { id: 'bad', title: 'Bad', url: 'javascript:alert(1)', position: 1 },
  ] }));
  assert.equal(response.status, 400);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM newtab_shortcuts').get().n, 2);
  sql.close();
});

test('recovery detaches missing folders, keeps local-only URLs and is idempotent', () => {
  const local = { shortcuts: [
    { id: 'local', title: 'Local', url: 'https://local.test', groupId: 'work', position: 0 },
    { id: 'old', title: 'Existing', note: 'Local note', url: 'https://first.test', groupId: 'deleted', folderId: 'lost', position: 1 },
  ], shortcutGroups: [{ id: 'work', name: 'Work', icon: 'Folder', position: 0 }] };
  const details = [
    { id: 's1', title: 'First', url: 'https://first.test' },
    { id: 's2', title: 'New', url: 'https://new.test' },
    { id: 's2', title: 'Duplicate', url: 'https://new.test' },
  ];
  const first = recovery.mergeCloudDetails(local, details);
  const second = recovery.mergeCloudDetails(first, details);
  assert.equal(first.shortcuts.length, 3);
  assert.deepEqual(first.shortcuts, second.shortcuts);
  assert.equal(first.shortcuts[0].groupId, 'work');
  assert.ok(first.shortcuts.slice(1).every(s => s.groupId === 'home' && !s.folderId));
  assert.equal(first.activeGroupId, 'home');
  assert.equal(first.shortcuts.find(s => s.id === 'old').note, 'Local note');
  assert.ok(first.shortcutGroups.some(g => g.id === 'home'));
});

test('GET recovery persists merged data; stale server or invalid key never changes local data', async () => {
  let stored = { config: { bookmarkSite: { apiUrl: 'https://my.test/api/', apiKey: 'test-key' } } };
  globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: {
    async get() { return stored; },
    async set(value) { stored = { ...stored, ...value }; },
  } } };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ data: { protocol: 2, revision: 1, entities: { groups: { home: { version: 1, value: { id: 'home', name: '首页', icon: 'Home', position: 0 } } }, folders: {}, shortcuts: { cloud: { version: 1, value: { id: 'cloud', title: 'Cloud', url: 'https://cloud.test', note: '', groupId: 'home', position: 0, createdAt: 1 } } } } } });
  };
  assert.equal(await recovery.restoreNewtabFromCloud(), 1);
  assert.equal(requests[0].url, 'https://my.test/api/tab/newtab/sync-v2');
  assert.equal(requests[0].options.headers['X-API-Key'], 'test-key');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(stored.newtab.shortcuts[0].groupId, 'home');
  const before = stored.newtab;
  globalThis.fetch = async () => Response.json({ data: { shortcuts: [] } });
  await assert.rejects(recovery.restoreNewtabFromCloud(), /Cloudflare/);
  assert.equal(stored.newtab, before);
  globalThis.fetch = async () => Response.json({ error: { message: 'Invalid key' } }, { status: 401 });
  await assert.rejects(recovery.restoreNewtabFromCloud(), /Invalid key/);
  assert.equal(stored.newtab, before);
});
