import './web-locks.mjs';
import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const output = mkdtempSync(join(tmpdir(), 'newtab-durable-'));
after(() => rmSync(output, { recursive: true, force: true }));
async function bundle(paths, name) {
  const outfile = join(output, name + '.mjs');
  await build({ stdin: { contents: paths.map(path => `export * from ${JSON.stringify(resolve(root, path))}`).join(';'), resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'esm', alias: { '@': join(root, 'src') }, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const core = await bundle(['src/newtab/services/sync-journal.ts', '../tmarks/shared/newtab-sync.ts'], 'core');
const engine = await bundle(['src/newtab/services/sync-engine.ts'], 'engine');
const api = await bundle(['../tmarks/functions/api/tab/newtab/sync-v2.ts'], 'api');
const get = api.onRequestGet.at(-1), post = api.onRequestPost.at(-1);
const shortcut = (id, extra = {}) => ({ id, title: id, url: `https://${id}.test`, note: '', groupId: 'home', position: 0, createdAt: 1, ...extra });
const op = (collection, id, value, baseVersion = 0) => ({ collection, id, value, baseVersion, mutationId: crypto.randomUUID() });
const snapshot = (items = []) => ({ revision: 1, entities: { groups: { home: { version: 1, value: { id: 'home', name: '首页', icon: 'Home', position: 0 } } }, folders: {}, shortcuts: Object.fromEntries(items.map(value => [value.id, { version: 1, value }])) } });
const localData = (...items) => ({ ...core.emptyLocal(), shortcuts: items.map(item => ({ clickCount: 0, ...item })) });
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE bookmarks (id TEXT PRIMARY KEY); CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner'), ('other');");
  sql.exec(readFileSync(resolve(root, '../tmarks/migrations/0100_d1_console.sql'), 'utf8').split('ALTER TABLE bookmarks')[0]);
  function prepare(query, params = []) {
    return { query, params, bind(...values) { return prepare(query, values); },
      async all() { return { results: sql.prepare(query).all(...params) }; },
      async first() { return sql.prepare(query).get(...params) || null; },
      async run() { return sql.prepare(query).run(...params); } };
  }
  const DB = { prepare, async batch(statements) {
    sql.exec('BEGIN');
    try {
      const results = statements.map(s => {
        const stmt = sql.prepare(s.query);
        return stmt.columns().length ? { results: stmt.all(...s.params) } : { results: [], meta: stmt.run(...s.params) };
      });
      sql.exec('COMMIT'); return results;
    } catch (e) { sql.exec('ROLLBACK'); throw e; }
  } };
  return { DB, sql };
}
const context = (DB, body, user = 'owner', permissions = ['bookmarks.*']) => ({ env: { DB }, data: { user_id: user, api_key_permissions: permissions }, request: new Request('https://test/api/tab/newtab/sync-v2', body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
async function read(DB, user) { const res = await get(context(DB, undefined, user)); assert.equal(res.status, 200); return (await res.json()).data; }
async function send(DB, revision, operations, user, permissions) { return post(context(DB, { revision, operations }, user, permissions)); }

// Core merge and outbox behaviour.
test('fresh install pulls all groups, folders, notes and icons without any inferred deletes', () => {
  const cloud = snapshot([shortcut('cloud', { folderId: 'folder', groupId: 'work', note: 'hello', fallbackIcon: 'Star', fallbackColor: '#abc', faviconBase64: 'data:image/png;base64,AAAA' })]);
  cloud.entities.groups.work = { version: 1, value: { id: 'work', name: 'Work', icon: 'Folder', position: 1 } };
  cloud.entities.folders.folder = { version: 1, value: { id: 'folder', name: 'Folder', groupId: 'work', position: 0, createdAt: 1 } };
  const journal = core.newJournal();
  core.bootstrap(core.emptyLocal(), journal, cloud);
  const merged = core.reconcile(core.emptyLocal(), journal, cloud);
  assert.deepEqual(journal.pending, {});
  assert.equal(merged.shortcuts[0].note, 'hello');
  assert.equal(merged.shortcuts[0].folderId, 'folder');
  assert.equal(merged.shortcuts[0].faviconBase64, 'data:image/png;base64,AAAA');
  assert.equal(merged.shortcutGroups.length, 2);
});
test('bootstrap keeps cloud-only and local-only items; colliding IDs need explicit choice', () => {
  const local = localData(shortcut('local'), shortcut('shared', { note: 'local note' }));
  const cloud = snapshot([shortcut('cloud'), shortcut('shared', { note: 'cloud note' })]);
  const journal = core.newJournal(); core.bootstrap(local, journal, cloud);
  const merged = core.reconcile(local, journal, cloud);
  assert.equal(merged.shortcuts.length, 3);
  assert.equal(journal.conflicts.length, 1);
  assert.equal(merged.shortcuts.find(s => s.id === 'shared').note, 'local note');
});
test('stale tab patches preserve another tab additions and merge edits on distinct fields', () => {
  const old = localData(shortcut('a'));
  const latest = localData(shortcut('a', { note: 'tab B note' }), shortcut('b'));
  const next = structuredClone(old); next.shortcuts[0].title = 'tab A title';
  const journal = core.newJournal(); journal.initialized = true; journal.remote = snapshot(old.shortcuts);
  const merged = core.persistPatch(old, next, latest, journal);
  assert.equal(merged.shortcuts.length, 2);
  assert.equal(merged.shortcuts[0].title, 'tab A title');
  assert.equal(merged.shortcuts[0].note, 'tab B note');
  assert.deepEqual(Object.keys(journal.pending), ['shortcuts:a']);
  assert.equal(journal.pending['shortcuts:a'].value.note, 'tab B note');
});
test('click count and UI preferences do not become cloud operations', () => {
  const before = localData(shortcut('a')); const next = structuredClone(before);
  next.shortcuts[0].clickCount++; next.settings.sidebarPinned = true;
  const journal = core.newJournal();
  core.persistPatch(before, next, before, journal);
  assert.deepEqual(journal.pending, {});
});
test('explicit deletion is durable and remote tombstone removes it on other devices', () => {
  const cloud = snapshot([shortcut('a'), shortcut('b')]);
  const journal = core.newJournal(); journal.remote = cloud; journal.initialized = true;
  core.persistPatch(localData(shortcut('a'), shortcut('b')), localData(shortcut('b')), localData(shortcut('a'), shortcut('b')), journal);
  const pending = JSON.parse(JSON.stringify(journal)).pending;
  assert.equal(pending['shortcuts:a'].value, null);
  assert.equal(pending['shortcuts:a'].baseVersion, 1);
  const deleted = core.applyOperations(cloud, Object.values(pending)).snapshot;
  assert.equal(deleted.entities.shortcuts.a.deleted, true);
  assert.equal(deleted.entities.shortcuts.a.value.title, 'a');
  const other = core.newJournal(); other.initialized = true; other.remote = cloud;
  assert.deepEqual(core.reconcile(localData(shortcut('a'), shortcut('b')), other, deleted).shortcuts.map(s => s.id), ['b']);
});
test('newer local edit during upload survives acknowledgement and is rebased', () => {
  const cloud = snapshot([shortcut('a')]); const journal = core.newJournal(); journal.initialized = true; journal.remote = cloud;
  core.queueValue(journal, 'shortcuts', 'a', shortcut('a', { note: 'first' }));
  const sent = structuredClone(Object.values(journal.pending));
  const remote = core.applyOperations(cloud, sent).snapshot;
  core.queueValue(journal, 'shortcuts', 'a', shortcut('a', { note: 'second' }));
  const merged = core.reconcile(localData(shortcut('a', { note: 'second' })), journal, remote, sent);
  assert.equal(merged.shortcuts[0].note, 'second');
  assert.equal(journal.pending['shortcuts:a'].baseVersion, remote.revision);
  assert.equal(journal.conflicts.length, 0);
});
test('reverting an in-flight edit back to its old value still queues an undo', () => {
  const cloud = snapshot([shortcut('a')]); const journal = core.newJournal(); journal.remote = cloud; journal.initialized = true;
  core.queueValue(journal, 'shortcuts', 'a', shortcut('a', { note: 'uploaded' }));
  const sent = structuredClone(Object.values(journal.pending));
  core.queueValue(journal, 'shortcuts', 'a', shortcut('a'));
  const merged = core.reconcile(localData(shortcut('a')), journal, core.applyOperations(cloud, sent).snapshot, sent);
  assert.equal(merged.shortcuts[0].note, '');
  assert.ok(journal.pending['shortcuts:a']);
  assert.equal(journal.conflicts.length, 0);
});
test('canonical merge clears removed folder and cached icon fields', () => {
  const remote = snapshot([shortcut('a')]);
  const journal = core.newJournal(); journal.initialized = true;
  const merged = core.reconcile(localData(shortcut('a', { folderId: 'old', faviconBase64: 'old', fallbackIcon: 'Star' })), journal, remote);
  assert.equal(merged.shortcuts[0].faviconBase64, undefined);
  assert.equal(merged.shortcuts[0].fallbackIcon, undefined);
  assert.equal(merged.shortcuts[0].folderId, undefined);
});
test('deleted parent group and folder never hide surviving shortcuts', () => {
  const cloud = snapshot([shortcut('a', { groupId: 'gone', folderId: 'gone' })]);
  const journal = core.newJournal(); journal.initialized = true;
  const result = core.reconcile(core.emptyLocal(), journal, cloud);
  assert.equal(result.shortcuts[0].groupId, 'home'); assert.equal(result.shortcuts[0].folderId, undefined);
});

// Real SQLite route tests: import, history, tombstones, permissions and atomicity.
test('v2 imports orphan legacy details plus grid safely; leaves all old tables intact', async () => {
  const { DB, sql } = database();
  sql.exec('PRAGMA foreign_keys = OFF'); // Reproduce historical orphaned rows.
  sql.exec(`INSERT INTO newtab_shortcuts (id,user_id,title,url,group_id,folder_id,position) VALUES
    ('a','owner','A','https://a.test','lost','missing',0), ('private','other','Private','https://private.test',NULL,NULL,0);
    INSERT INTO newtab_grid_items (id,user_id,type,shortcut_title,shortcut_url,position) VALUES
    ('grid','owner','shortcut','Grid','https://grid.test',1), ('unsafe','owner','shortcut','Bad','javascript:alert(1)',2);`);
  const cloud = await read(DB);
  assert.deepEqual(Object.keys(cloud.entities.shortcuts), ['a', 'grid']);
  assert.equal(cloud.entities.shortcuts.a.value.groupId, 'home');
  assert.equal(cloud.entities.shortcuts.a.value.folderId, undefined);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM newtab_groups').get().n, 0);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM newtab_shortcuts').get().n, 2);
  sql.close();
});
test('empty upload cannot wipe cloud; updates backup history; deletion retains recoverable value', async () => {
  const { DB, sql } = database(); const initial = await read(DB);
  const all = [op('groups', 'work', { id: 'work', name: 'Work', icon: 'Folder', position: 1 }),
    op('folders', 'folder', { id: 'folder', name: 'Folder', groupId: 'work', position: 0, createdAt: 1 }),
    op('shortcuts', 'a', shortcut('a', { note: 'note', folderId: 'folder', groupId: 'work', faviconBase64: 'data:image/png;base64,AAAA', fallbackIcon: 'Star', fallbackColor: '#fff' }))];
  let response = await send(DB, initial.revision, all); assert.equal(response.status, 200);
  let cloud = (await response.json()).data;
  const revision = cloud.revision;
  response = await send(DB, revision, []); assert.equal(response.status, 200);
  cloud = (await response.json()).data;
  assert.equal(cloud.revision, revision); assert.equal(cloud.entities.shortcuts.a.value.note, 'note');
  response = await send(DB, revision, all); assert.equal(response.status, 200); // lost response replay
  assert.equal((await response.json()).data.revision, revision);
  response = await send(DB, revision, [op('shortcuts', 'a', null, revision)]); assert.equal(response.status, 200);
  cloud = (await response.json()).data;
  assert.equal(cloud.entities.shortcuts.a.deleted, true);
  assert.equal(cloud.entities.shortcuts.a.value.note, 'note');
  const history = sql.prepare('SELECT payload FROM newtab_sync_history WHERE user_id=? AND revision=?').get('owner', revision);
  assert.equal(JSON.parse(history.payload).shortcuts.a.value.folderId, 'folder');
  assert.equal((await read(DB, 'other')).entities.shortcuts.a, undefined);
  sql.close();
});
test('stale update/delete batches fail atomically; unrelated concurrent edits merge', async () => {
  const { DB, sql } = database(); await read(DB);
  let response = await send(DB, 1, [op('shortcuts', 'a', shortcut('a')), op('shortcuts', 'b', shortcut('b'))]);
  const original = (await response.json()).data;
  response = await send(DB, original.revision, [op('shortcuts', 'a', shortcut('a', { note: 'new' }), original.revision)]);
  assert.equal(response.status, 200);
  response = await send(DB, original.revision, [op('shortcuts', 'a', null, original.revision), op('shortcuts', 'c', shortcut('c'))]);
  assert.equal(response.status, 409);
  assert.equal((await read(DB)).entities.shortcuts.c, undefined);
  response = await send(DB, original.revision, [op('shortcuts', 'b', shortcut('b', { note: 'unrelated' }), original.revision)]);
  assert.equal(response.status, 200);
  const cloud = (await response.json()).data;
  assert.equal(cloud.entities.shortcuts.a.value.note, 'new'); assert.equal(cloud.entities.shortcuts.b.value.note, 'unrelated');
  sql.close();
});
test('validates whole batch, prototype IDs, deletion and update permissions before mutation', async () => {
  const { DB, sql } = database(); await read(DB);
  for (const invalid of [op('shortcuts', '__proto__', shortcut('__proto__')), op('shortcuts', 'bad', shortcut('bad', { url: 'javascript:alert(1)' })), op('groups', 'home', null, 1)]) {
    const response = await send(DB, 1, [op('shortcuts', 'a', shortcut('a')), invalid]); assert.equal(response.status, 400);
  }
  assert.equal((await read(DB)).entities.shortcuts.a, undefined);
  let response = await send(DB, 1, [op('shortcuts', 'a', shortcut('a'))]);
  const cloud = (await response.json()).data;
  response = await send(DB, cloud.revision, [op('shortcuts', 'a', null, cloud.revision)], 'owner', ['bookmarks.create']); assert.equal(response.status, 403);
  response = await send(DB, cloud.revision, [op('shortcuts', 'a', shortcut('a', { note: 'forbidden' }), cloud.revision)], 'owner', ['bookmarks.create']); assert.equal(response.status, 403);
  assert.equal((await read(DB)).entities.shortcuts.a.value.note, '');
  sql.close();
});
test('CAS race preserves winner; retry merges unrelated operations without losing history', async () => {
  const { DB, sql } = database(); await read(DB);
  const responses = await Promise.all([
    send(DB, 1, [op('shortcuts', 'a', shortcut('a'))]),
    send(DB, 1, [op('shortcuts', 'b', shortcut('b'))]),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const cloud = await read(DB);
  const absent = cloud.entities.shortcuts.a ? 'b' : 'a';
  const retry = await send(DB, cloud.revision, [op('shortcuts', absent, shortcut(absent))]);
  assert.equal(retry.status, 200);
  assert.equal(Object.keys((await read(DB)).entities.shortcuts).length, 2);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM newtab_sync_history').get().n, 2);
  sql.close();
});

// End-to-end engine against mocked transport with durable chrome.storage.
let saved, cloud, requests;
beforeEach(() => {
  saved = { config: { bookmarkSite: { apiUrl: 'https://test/api', apiKey: 'key' } }, newtab: core.emptyLocal() };
  cloud = snapshot([shortcut('cloud')]); requests = [];
  globalThis.chrome = { storage: { onChanged: { addListener() {} }, local: {
    async get() { return structuredClone(saved); }, async set(data) { Object.assign(saved, structuredClone(data)); },
  } } };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      const result = core.applyOperations(cloud, JSON.parse(options.body).operations);
      if (result.conflicts.length) return Response.json({ data: { protocol: 2, ...cloud, conflicts: result.conflicts } }, { status: 409 });
      cloud = result.snapshot;
    }
    return Response.json({ data: { protocol: 2, ...cloud } });
  };
});
test('engine initial pull has no POST and can retry persisted offline edits after restart', async () => {
  await engine.runNewtabSync();
  assert.equal(requests.length, 1); assert.equal(requests[0].options.method, 'GET');
  assert.equal(saved.newtab.shortcuts[0].id, 'cloud');
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'offline';
  await engine.saveLocalPatch(before, next);
  const network = globalThis.fetch; globalThis.fetch = async () => { throw new Error('offline'); };
  await engine.runNewtabSync(); assert.equal(saved[engine.SYNC_KEY].phase, 'error');
  assert.equal(saved[engine.SYNC_KEY].pending['shortcuts:cloud'].value.note, 'offline');
  saved = JSON.parse(JSON.stringify(saved)); globalThis.fetch = network;
  await engine.runNewtabSync();
  assert.equal(cloud.entities.shortcuts.cloud.value.note, 'offline');
  assert.equal(saved[engine.SYNC_KEY].phase, 'synced'); assert.deepEqual(saved[engine.SYNC_KEY].pending, {});
});
test('engine remote edit conflict preserves both versions until explicit resolution', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'mine';
  await engine.saveLocalPatch(before, next);
  cloud = core.applyOperations(cloud, [op('shortcuts', 'cloud', shortcut('cloud', { note: 'theirs' }), 1)]).snapshot;
  await engine.runNewtabSync();
  assert.equal(saved[engine.SYNC_KEY].phase, 'conflict'); assert.equal(saved.newtab.shortcuts[0].note, 'mine');
  assert.equal(cloud.entities.shortcuts.cloud.value.note, 'theirs');
  await engine.resolveSyncConflict('shortcuts:cloud', 'cloud');
  assert.equal(saved.newtab.shortcuts[0].note, 'theirs');
  await engine.runNewtabSync(); assert.equal(saved[engine.SYNC_KEY].phase, 'synced');
});
test('engine preserves new edits made while a POST is in flight', async () => {
  await engine.runNewtabSync();
  let before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'first';
  await engine.saveLocalPatch(before, next);
  const network = globalThis.fetch; let edited = false;
  globalThis.fetch = async (url, options) => {
    const response = await network(url, options);
    if (options.method === 'POST' && !edited) {
      edited = true; before = structuredClone(saved.newtab); next = structuredClone(before); next.shortcuts[0].note = 'second';
      await engine.saveLocalPatch(before, next);
    }
    return response;
  };
  await engine.runNewtabSync();
  assert.equal(cloud.entities.shortcuts.cloud.value.note, 'second'); assert.equal(saved.newtab.shortcuts[0].note, 'second');
  assert.deepEqual(saved[engine.SYNC_KEY].pending, {});
});
test('server incompatibility never changes local shortcuts; missing key leaves edits queued', async () => {
  saved.newtab = localData(shortcut('local'));
  const before = JSON.stringify(saved.newtab);
  globalThis.fetch = async () => Response.json({ data: { recovery_version: 1, shortcuts: [] } });
  await engine.runNewtabSync(); assert.equal(saved[engine.SYNC_KEY].phase, 'error'); assert.equal(JSON.stringify(saved.newtab), before);
});

test('a stale page cannot silently resurrect a remotely deleted shortcut', () => {
  const view = snapshot([shortcut('a')]);
  const remote = core.applyOperations(view, [op('shortcuts', 'a', null, 1)]).snapshot;
  const journal = core.newJournal(); journal.initialized = true; journal.remote = remote;
  const next = localData(shortcut('a', { note: 'stale edit' }));
  const local = core.persistPatch(localData(shortcut('a')), next, core.emptyLocal(), journal, view);
  assert.equal(journal.pending['shortcuts:a'].baseVersion, 1);
  core.reconcile(local, journal, remote);
  assert.equal(journal.conflicts.length, 1);
  assert.equal(core.applyOperations(remote, Object.values(journal.pending)).conflicts.length, 1);
});
test('switching server or API key pauses before any request, backs up pending data and pulls the new account', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'old account private';
  await engine.saveLocalPatch(before, next);
  saved.config.bookmarkSite.apiKey = 'different-key';
  const n = requests.length;
  await engine.runNewtabSync();
  assert.equal(saved[engine.SYNC_KEY].phase, 'account-changed'); assert.equal(requests.length, n);
  assert.equal(saved.newtab.shortcuts[0].note, 'old account private');
  await engine.switchSyncAccount();
  const backup = Object.keys(saved).find(key => key.startsWith('newtab_account_backup_'));
  assert.equal(saved[backup].local.shortcuts[0].note, 'old account private');
  assert.ok(saved[backup].journal.pending['shortcuts:cloud']);
  cloud = snapshot([shortcut('new-account')]);
  await engine.runNewtabSync();
  assert.deepEqual(saved.newtab.shortcuts.map(s => s.id), ['new-account']);
  assert.deepEqual(Object.keys(cloud.entities.shortcuts), ['new-account']);
});
test('missing key keeps local operations durable and makes no network request', async () => {
  saved.config.bookmarkSite.apiKey = '';
  const next = localData(shortcut('local'));
  await engine.saveLocalPatch(core.emptyLocal(), next);
  await engine.runNewtabSync();
  assert.equal(saved[engine.SYNC_KEY].phase, 'unconfigured');
  assert.equal(requests.length, 0); assert.ok(saved[engine.SYNC_KEY].pending['shortcuts:local']);
});
test('lost POST response is recovered by reading the acknowledged mutation', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'accepted once';
  await engine.saveLocalPatch(before, next);
  const network = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await network(url, options);
    if (options.method === 'POST') throw new Error('response lost');
    return response;
  };
  await engine.runNewtabSync();
  assert.equal(cloud.entities.shortcuts.cloud.value.note, 'accepted once');
  assert.equal(saved[engine.SYNC_KEY].phase, 'synced'); assert.deepEqual(saved[engine.SYNC_KEY].pending, {});
});
test('choosing local conflict content rebases only after explicit selection', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'mine';
  await engine.saveLocalPatch(before, next);
  cloud = core.applyOperations(cloud, [op('shortcuts', 'cloud', shortcut('cloud', { note: 'theirs' }), 1)]).snapshot;
  await engine.runNewtabSync(); assert.equal(saved[engine.SYNC_KEY].phase, 'conflict');
  await engine.resolveSyncConflict('shortcuts:cloud', 'local');
  await engine.runNewtabSync();
  assert.equal(cloud.entities.shortcuts.cloud.value.note, 'mine'); assert.equal(saved[engine.SYNC_KEY].phase, 'synced');
});

test('a page from the old account cannot persist its stale edits after an account switch', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before);
  const oldScope = saved[engine.SYNC_KEY].scope;
  const oldRemote = structuredClone(saved[engine.SYNC_KEY].remote);
  next.shortcuts.push(shortcut('old-account-addition'));
  saved.config.bookmarkSite.apiKey = 'new-key'; await engine.switchSyncAccount();
  await assert.rejects(engine.saveLocalPatch(before, next, oldRemote, oldScope), /账户已切换/);
  assert.deepEqual(saved.newtab.shortcuts, []);
  assert.deepEqual(saved[engine.SYNC_KEY].pending, {});
});

test('adopting a cloud version that has no record removes the conflicting local record', async () => {
  await engine.runNewtabSync();
  const before = structuredClone(saved.newtab), next = structuredClone(before); next.shortcuts[0].note = 'local';
  await engine.saveLocalPatch(before, next);
  cloud = snapshot(); cloud.revision = 2;
  await engine.runNewtabSync(); assert.equal(saved[engine.SYNC_KEY].phase, 'conflict');
  await engine.resolveSyncConflict('shortcuts:cloud', 'cloud');
  assert.deepEqual(saved.newtab.shortcuts, []); assert.deepEqual(saved[engine.SYNC_KEY].pending, {});
});
