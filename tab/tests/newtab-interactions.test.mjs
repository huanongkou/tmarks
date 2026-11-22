import './web-locks.mjs';
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const output = mkdtempSync(join(tmpdir(), 'tmarks-interaction-tests-'));
after(() => rmSync(output, { recursive: true, force: true }));
async function bundle(entry, filename) {
  const outfile = join(output, filename);
  const contents = `export * from ${JSON.stringify(join(root, entry))};` +
    (entry.endsWith('useNewtabStore.ts') ? `export * from ${JSON.stringify(join(root, 'src/newtab/services/shortcut-actions.ts'))};` : '');
  await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { '@': join(root, 'src') }, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const { useNewtabStore: store, saveShortcutEdits, refreshShortcutIcon } = await bundle('src/newtab/hooks/useNewtabStore.ts', 'store.mjs');
const { newtabCollisionDetection: collide } = await bundle('src/newtab/utils/drag-collision.ts', 'collision.mjs');
const { getGroupLayout } = await bundle('src/newtab/utils/group-layout.ts', 'group-layout.mjs');
let saved;
beforeEach(async () => {
  saved = { config: { bookmarkSite: { apiUrl: '', apiKey: '' } }, newtab: {
    shortcuts: [
      { id: 'source', title: 'Source', url: 'https://source.test', groupId: 'home', position: 0 },
      { id: 'destination', title: 'Work', url: 'https://work.test', groupId: 'work', position: 4 },
      { id: 'inside', title: 'Inside', url: 'https://inside.test', groupId: 'home', folderId: 'folder', position: 1 },
    ],
    shortcutGroups: [{ id: 'home', name: 'Home' }, { id: 'work', name: 'Work' }],
    shortcutFolders: [{ id: 'folder', name: 'Folder', groupId: 'home' }],
    activeGroupId: 'home', settings: {}, gridItems: [],
  } };
  globalThis.chrome = { storage: {
    onChanged: { addListener() {} },
    local: { async get() { return structuredClone(saved); }, async set(value) { Object.assign(saved, structuredClone(value)); } },
  } };
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  await store.getState().loadData();
});

test('old settings default to auto hide; pin survives reloading without persisting drag state', async () => {
  assert.equal(store.getState().settings.sidebarPinned, false);
  store.setState({ draggingShortcutId: 'source' });
  store.getState().updateSettings({ sidebarPinned: true });
  await store.getState().loadData();
  assert.equal(saved.newtab.settings.sidebarPinned, true);
  assert.equal('draggingShortcutId' in saved.newtab, false);
  await store.getState().loadData();
  assert.equal(store.getState().settings.sidebarPinned, true);
  store.getState().updateSettings({ sidebarPinned: false });
  await store.getState().loadData();
  await store.getState().loadData();
  assert.equal(store.getState().settings.sidebarPinned, false);
});

test('group move keeps shortcut identity, moves it out of the source and appends in target', async () => {
  store.getState().moveShortcutToGroup('source', 'work');
  await store.getState().loadData();
  assert.equal(store.getState().getFilteredShortcuts().some(s => s.id === 'source'), false);
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'source').groupId, 'work');
  await store.getState().loadData();
  store.getState().setActiveGroup('work');
  await store.getState().loadData();
  assert.deepEqual(store.getState().getFilteredShortcuts().map(s => s.id), ['destination', 'source']);
  assert.equal(store.getState().shortcuts.length, 3);
});

test('moving a shortcut out of a folder removes its folder reference', async () => {
  store.getState().moveShortcutToGroup('inside', 'work');
  await store.getState().loadData();
  const moved = saved.newtab.shortcuts.find(s => s.id === 'inside');
  assert.equal(moved.groupId, 'work');
  assert.equal(moved.folderId, undefined);
  assert.equal(saved.newtab.shortcutFolders.length, 1);
});

test('invalid destinations and dropping into the same group do not change data', async () => {
  const before = JSON.stringify(saved.newtab);
  store.getState().moveShortcutToGroup('source', 'missing');
  await store.getState().loadData();
  store.getState().moveShortcutToGroup('missing', 'work');
  await store.getState().loadData();
  store.getState().moveShortcutToGroup('source', 'home');
  await store.getState().loadData();
  assert.equal(JSON.stringify(saved.newtab), before);
});

test('deleting one shortcut preserves other shortcuts, folders and groups', async () => {
  store.getState().removeShortcut('inside');
  await store.getState().loadData();
  await store.getState().loadData();
  assert.deepEqual(store.getState().shortcuts.map(s => s.id), ['source', 'destination']);
  assert.equal(store.getState().shortcutFolders.length, 1);
  assert.equal(store.getState().shortcutGroups.length, 2);
});

function rect(left, top, width, height) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}
function collisionArgs(pointer, { type = 'shortcut', disabled = false, folderId } = {}) {
  const groupRect = rect(0, 0, 200, 80);
  const shortcutRect = rect(300, 0, 80, 80);
  return {
    active: { id: 'source', data: { current: { type, folderId } } },
    pointerCoordinates: pointer,
    collisionRect: rect(pointer.x, pointer.y, 60, 60),
    droppableRects: new Map([['group:work', groupRect], ['neighbor', shortcutRect]]),
    droppableContainers: [
      { id: 'group:work', disabled, data: { current: { type: 'group', groupId: 'work' } }, rect: { current: groupRect } },
      { id: 'neighbor', disabled: false, data: { current: { type: 'shortcut' } }, rect: { current: shortcutRect } },
    ],
  };
}

test('group accepts a shortcut only on an actual pointer hit', async () => {
  assert.equal(collide(collisionArgs({ x: 100, y: 30 }))[0].id, 'group:work');
  assert.equal(collide(collisionArgs({ x: 210, y: 30 }))[0].id, 'neighbor');
  assert.equal(collide(collisionArgs({ x: 320, y: 30 }))[0].id, 'neighbor');
});

test('unpinned groups and folder drags cannot become group drop targets', async () => {
  assert.equal(collide(collisionArgs({ x: 100, y: 30 }, { disabled: true }))[0].id, 'neighbor');
  assert.equal(collide(collisionArgs({ x: 100, y: 30 }, { type: 'folder' }))[0].id, 'neighbor');
});

test('a shortcut inside a folder can target the sidebar but cannot reorder the background grid', async () => {
  assert.equal(collide(collisionArgs({ x: 100, y: 30 }, { folderId: 'folder' }))[0].id, 'group:work');
  assert.deepEqual(collide(collisionArgs({ x: 320, y: 30 }, { folderId: 'folder' })), []);
});


test('group sorting persists positions and preserves selection and shortcut ownership', async () => {
  const shortcuts = structuredClone(store.getState().shortcuts);
  store.getState().reorderGroups('work', 'home');
  await store.getState().loadData();
  await store.getState().loadData();
  assert.deepEqual(store.getState().shortcutGroups.map(group => group.id), ['work', 'home']);
  assert.deepEqual(store.getState().shortcutGroups.map(group => group.position), [0, 1]);
  assert.equal(store.getState().activeGroupId, 'home');
  assert.deepEqual(store.getState().shortcuts, shortcuts);
  store.getState().reorderGroups('missing', 'home');
  await store.getState().loadData();
  assert.deepEqual(store.getState().shortcutGroups.map(group => group.id), ['work', 'home']);
});

test('group drag only collides with groups, and dropping outside does nothing', async () => {
  assert.equal(collide(collisionArgs({ x: 100, y: 30 }, { type: 'group' }))[0].id, 'group:work');
  assert.deepEqual(collide(collisionArgs({ x: 320, y: 30 }, { type: 'group' })), []);
});

test('crowded group lists use multiple columns and always fit the available height', async () => {
  assert.equal(getGroupLayout(3, 400, 208).columns, 1);
  assert.ok(getGroupLayout(20, 400, 208).columns > 1);
  for (const count of [0, 1, 12, 30, 100, 200]) {
    for (const height of [80, 240, 400, 600]) {
      for (const width of [64, 184, 208]) {
        const layout = getGroupLayout(count, height, width);
        assert.ok(layout.rows * layout.columns >= count);
        assert.ok(layout.rows * layout.rowHeight + (layout.rows - 1) * layout.gap <= height + 0.001);
        assert.ok(layout.columns <= Math.max(1, Math.floor(width / 64)));
      }
    }
  }
});


test('editing saves title, address and notes without changing group, position or identity', async () => {
  store.getState().updateShortcut('source', { faviconBase64: 'old-cache', favicon: 'https://old.test/icon.png' });
  await store.getState().loadData();
  saveShortcutEdits('source', 'https://edited.test', 'Edited', 'First line\nSecond line');
  await store.getState().loadData();
  await store.getState().loadData();
  const item = store.getState().shortcuts.find(s => s.id === 'source');
  assert.equal(item.title, 'Edited');
  assert.equal(item.url, 'https://edited.test');
  assert.equal(item.note, 'First line\nSecond line');
  assert.equal(item.groupId, 'home');
  assert.equal(item.position, 0);
  assert.equal(item.faviconBase64, undefined);
  assert.equal(item.favicon, undefined);
  saveShortcutEdits('source', item.url, item.title, '');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'source').note, '');
});

test('editing only a note preserves existing cached icon', async () => {
  store.getState().updateShortcut('inside', { faviconBase64: 'keep-cache' });
  await store.getState().loadData();
  saveShortcutEdits('inside', 'https://inside.test', 'Inside', 'Folder note');
  await store.getState().loadData();
  const item = saved.newtab.shortcuts.find(s => s.id === 'inside');
  assert.equal(item.note, 'Folder note');
  assert.equal(item.faviconBase64, 'keep-cache');
  assert.equal(item.folderId, 'folder');
});

test('refresh replaces cached favicon and requests a fresh image, preserving notes', async () => {
  store.getState().updateShortcut('source', { faviconBase64: 'old-cache', note: 'Keep note' });
  await store.getState().loadData();
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,new-icon'; this.onloadend(); }
  };
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(new Uint8Array(128), { headers: { 'Content-Type': 'image/png' } });
  };
  const refresh = refreshShortcutIcon('source');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'source').faviconBase64, undefined);
  assert.equal(await refresh, true);
  await store.getState().loadData();
  assert.equal(requests[0].options.cache, 'reload');
  assert.match(requests[0].url, /_refresh=/);
  const item = saved.newtab.shortcuts.find(s => s.id === 'source');
  assert.equal(item.faviconBase64, 'data:image/png;base64,new-icon');
  assert.equal(item.note, 'Keep note');
});

test('a pending refresh never overwrites the icon after the shortcut address changes', async () => {
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  const refresh = refreshShortcutIcon('source');
  await store.getState().loadData();
  saveShortcutEdits('source', 'https://changed.test', 'Changed', 'New note');
  await store.getState().loadData();
  release(new Response(null, { status: 503 }));
  assert.equal(await refresh, false);
  const item = saved.newtab.shortcuts.find(s => s.id === 'source');
  assert.equal(item.url, 'https://changed.test');
  assert.equal(item.favicon, undefined);
  assert.equal(item.note, 'New note');
});

test('failed refresh assigns and persists a random library icon while preserving shortcut content', async () => {
  store.getState().updateShortcut('source', { note: 'Keep note', faviconBase64: 'old-cache' });
  await store.getState().loadData();
  globalThis.fetch = async () => new Response(null, { status: 503 });
  assert.equal(await refreshShortcutIcon('source'), false);
  await store.getState().loadData();
  const item = saved.newtab.shortcuts.find(s => s.id === 'source');
  assert.ok(['Globe2', 'Bookmark', 'BookOpen', 'Briefcase', 'Code2', 'Compass', 'Coffee', 'Heart',
    'Lightbulb', 'Music', 'Palette', 'Rocket', 'Star', 'Flame', 'Camera', 'Gem'].includes(item.fallbackIcon));
  assert.ok(['blue', 'violet', 'emerald', 'amber', 'rose', 'cyan'].includes(item.fallbackColor));
  assert.equal(item.faviconBase64, undefined);
  assert.equal(item.note, 'Keep note');
  assert.equal(item.url, 'https://source.test');
  await store.getState().loadData();
  assert.equal(store.getState().shortcuts.find(s => s.id === 'source').fallbackIcon, item.fallbackIcon);
  assert.equal(store.getState().shortcuts.find(s => s.id === 'source').fallbackColor, item.fallbackColor);
});

test('HTTP 200 containing an error page selects a library icon', async () => {
  globalThis.fetch = async () => new Response('not an image'.repeat(30), { headers: { 'Content-Type': 'text/html' } });
  assert.equal(await refreshShortcutIcon('source'), false);
  await store.getState().loadData();
  assert.ok(saved.newtab.shortcuts.find(s => s.id === 'source').fallbackIcon);
});

test('successful refresh clears the library fallback; changing only notes preserves it', async () => {
  store.getState().updateShortcut('source', { fallbackIcon: 'Rocket', fallbackColor: 'violet' });
  await store.getState().loadData();
  saveShortcutEdits('source', 'https://source.test', 'Source', 'Library note');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'source').fallbackIcon, 'Rocket');
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,valid-icon'; this.onloadend(); }
  };
  globalThis.fetch = async () => new Response(new Uint8Array(128), { headers: { 'Content-Type': 'image/png' } });
  assert.equal(await refreshShortcutIcon('source'), true);
  await store.getState().loadData();
  const item = saved.newtab.shortcuts.find(s => s.id === 'source');
  assert.equal(item.fallbackIcon, undefined);
  assert.equal(item.fallbackColor, undefined);
  assert.equal(item.note, 'Library note');
  assert.equal(item.faviconBase64, 'data:image/png;base64,valid-icon');
  store.getState().updateShortcut('source', { fallbackIcon: 'Star', fallbackColor: 'blue' });
  await store.getState().loadData();
  saveShortcutEdits('source', 'https://changed.test', 'Changed', '');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'source').fallbackIcon, undefined);
});

test('moving a shortcut into an existing folder persists its membership and preserves notes and icons', async () => {
  store.getState().updateShortcut('source', { note: 'Keep note', fallbackIcon: 'Rocket', fallbackColor: 'violet' });
  await store.getState().loadData();
  store.getState().moveShortcutToFolder('source', 'folder');
  await store.getState().loadData();
  await store.getState().loadData();
  assert.equal(store.getState().getFilteredShortcuts().some(s => s.id === 'source'), false);
  assert.deepEqual(store.getState().getFolderShortcuts('folder').map(s => s.id), ['inside', 'source']);
  const item = store.getState().shortcuts.find(s => s.id === 'source');
  assert.equal(item.folderId, 'folder');
  assert.equal(item.groupId, 'home');
  assert.equal(item.note, 'Keep note');
  assert.equal(item.fallbackIcon, 'Rocket');
  assert.equal(store.getState().shortcuts.length, 3);
  store.getState().moveShortcutToFolder('source', undefined);
  await store.getState().loadData();
  assert.equal(store.getState().getFolderShortcuts('folder').some(s => s.id === 'source'), false);
  assert.ok(store.getState().getFilteredShortcuts().some(s => s.id === 'source'));
});

test('folder moves validate destination, avoid duplication and inherit the folder group', async () => {
  const before = JSON.stringify(saved.newtab);
  store.getState().moveShortcutToFolder('source', 'missing');
  await store.getState().loadData();
  store.getState().moveShortcutToFolder('missing', 'folder');
  await store.getState().loadData();
  assert.equal(JSON.stringify(saved.newtab), before);
  store.getState().moveShortcutToFolder('destination', 'folder');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 'destination').groupId, 'home');
  const first = JSON.stringify(saved.newtab);
  store.getState().moveShortcutToFolder('destination', 'folder');
  await store.getState().loadData();
  assert.equal(JSON.stringify(saved.newtab), first);
});

test('shortcut drag hits a folder immediately without an active source or nearest-folder false positive', async () => {
  const args = collisionArgs({ x: 100, y: 30 });
  args.droppableContainers[0].data.current = { type: 'folder', groupId: 'home' };
  const sourceRect = rect(0, 0, 80, 80);
  args.droppableContainers.push({ id: 'source', disabled: false, data: { current: { type: 'shortcut' } }, rect: { current: sourceRect } });
  args.droppableRects.set('source', sourceRect);
  assert.equal(collide(args)[0].id, 'group:work');
  args.pointerCoordinates = { x: 210, y: 30 };
  assert.equal(collide(args)[0].id, 'neighbor');
  args.pointerCoordinates = { x: 10, y: 10 };
  assert.equal(collide(args)[0].id, 'group:work');
});

test('folders and shortcuts share a saved order without changing contents or other groups', async () => {
  store.setState({
    shortcutFolders: [
      { id: 'f1', name: 'One', groupId: 'home', position: 0 },
      { id: 'f2', name: 'Two', groupId: 'home', position: 2 },
      { id: 'other-folder', name: 'Other', groupId: 'work', position: 9 },
    ],
    shortcuts: [
      { id: 's1', title: 'Root', url: 'https://root.test', groupId: 'home', position: 1, note: 'Keep note' },
      { id: 'inside', title: 'Inside', url: 'https://inside.test', groupId: 'home', folderId: 'f1', position: 7 },
      { id: 'other', title: 'Other', url: 'https://other.test', groupId: 'work', position: 8 },
    ],
  });
  store.getState().reorderGroupItems('f2', 'f1');
  await store.getState().loadData();
  await store.getState().loadData();
  assert.equal(store.getState().shortcutFolders.find(f => f.id === 'f2').position, 0);
  assert.equal(store.getState().shortcutFolders.find(f => f.id === 'f1').position, 1);
  assert.equal(store.getState().shortcuts.find(s => s.id === 's1').position, 2);
  assert.equal(store.getState().shortcuts.find(s => s.id === 'inside').position, 7);
  assert.equal(store.getState().shortcuts.find(s => s.id === 'inside').folderId, 'f1');
  assert.equal(store.getState().shortcutFolders.find(f => f.id === 'other-folder').position, 9);
  assert.equal(store.getState().shortcuts.find(s => s.id === 'other').position, 8);
  store.getState().reorderGroupItems('f2', 's1');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcutFolders.find(f => f.id === 'f2').position, 2);
  assert.equal(saved.newtab.shortcutFolders.find(f => f.id === 'f1').position, 0);
  assert.equal(saved.newtab.shortcuts.find(s => s.id === 's1').position, 1);
  const before = JSON.stringify(saved.newtab);
  store.getState().reorderGroupItems('f2', 'other-folder');
  await store.getState().loadData();
  store.getState().reorderGroupItems('missing', 'f1');
  await store.getState().loadData();
  assert.equal(JSON.stringify(saved.newtab), before);
  store.getState().removeShortcut('s1');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcutFolders.find(f => f.id === 'f2').position, 2);
});

test('new folders append after the current mixed order', async () => {
  store.getState().updateFolder('folder', { position: 20 });
  await store.getState().loadData();
  const newId = store.getState().addFolder('Appended', 'home');
  await store.getState().loadData();
  assert.equal(saved.newtab.shortcutFolders.find(f => f.id === newId).position, 21);
});

test('dragging a folder can target another folder for sorting', async () => {
  const args = collisionArgs({ x: 100, y: 30 }, { type: 'folder' });
  args.droppableContainers[0].data.current = { type: 'folder', groupId: 'home' };
  assert.equal(collide(args)[0].id, 'group:work');
});

test('group and folder edits, ordering and deletion all enter the durable sync journal', async () => {
  store.getState().updateGroup('work', { name: 'Renamed', icon: 'Star' });
  store.getState().reorderGroups('work', 'home');
  store.getState().updateFolder('folder', { name: 'Folder renamed', icon: 'Heart', position: 9, groupId: 'work' });
  await store.getState().loadData();
  const pending = saved.newtab_sync_v2.pending;
  assert.equal(pending['groups:work'].value.name, 'Renamed');
  assert.equal(pending['groups:work'].value.position, 0);
  assert.equal(pending['folders:folder'].value.name, 'Folder renamed');
  assert.equal(pending['folders:folder'].value.position, 9);
  store.getState().removeGroup('work');
  await store.getState().loadData();
  assert.equal(saved.newtab_sync_v2.pending['groups:work'].value, null);
  assert.equal(saved.newtab_sync_v2.pending['folders:folder'].value.groupId, 'home');
  assert.equal(saved.newtab_sync_v2.pending['shortcuts:destination'].value.groupId, 'home');
  store.getState().removeFolder('folder');
  await store.getState().loadData();
  assert.equal(saved.newtab_sync_v2.pending['folders:folder'].value, null);
  assert.equal(saved.newtab_sync_v2.pending['shortcuts:inside'].value.folderId, undefined);
});
