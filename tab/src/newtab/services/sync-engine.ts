import { normalizeApiUrl } from '@/lib/constants/urls';
import { STORAGE_KEY } from '../constants';
import type { NewTabStorage } from '../types';
import { SYNC_KEY, emptyLocal, newJournal, persistPatch, bootstrap, reconcile, operationKey, LOCAL_KEYS,
  type SyncJournal, type SyncSnapshot, type SyncOperation } from './sync-journal';
export { SYNC_KEY };
export type { SyncJournal };

// Web Locks are shared by extension pages and its service worker. The data and
// durable outbox are written together; network requests never hold this lock.
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return navigator.locks.request('tmarks-newtab-storage-v2', fn);
}
async function readLocal() {
  const stored = await chrome.storage.local.get([STORAGE_KEY, SYNC_KEY]);
  return { local: (stored[STORAGE_KEY] || emptyLocal()) as NewTabStorage, journal: (stored[SYNC_KEY] || newJournal()) as SyncJournal };
}
export async function saveLocalPatch(previous: NewTabStorage, next: NewTabStorage, viewRemote?: SyncSnapshot, viewScope?: string) {
  return withSyncLock(async () => {
    const { local, journal } = await readLocal();
    if (viewScope && journal.scope !== viewScope) throw new Error('账户已切换，请等待页面刷新后重试');
    const merged = persistPatch(previous, next, local, journal, viewRemote);
    await chrome.storage.local.set({ [STORAGE_KEY]: merged, [SYNC_KEY]: journal });
    return merged;
  });
}
async function credentials() {
  const stored = await chrome.storage.local.get('config');
  const config = (stored.config as { bookmarkSite?: { apiUrl?: string; apiKey?: string } } | undefined)?.bookmarkSite;
  const base = normalizeApiUrl(config?.apiUrl || '');
  const key = config?.apiKey || '';
  // The fingerprint is not the API key. It prevents accidental cross-account uploads.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${base}\n${key}`));
  return { base, key, scope: Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('') };
}
class SyncRaceError extends Error {}
async function requestCloud(config: Awaited<ReturnType<typeof credentials>>, body?: object): Promise<SyncSnapshot> {
  const response = await fetch(`${config.base}/tab/newtab/sync-v2`, {
    method: body ? 'POST' : 'GET', headers: { 'X-API-Key': config.key, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 409) throw new SyncRaceError('云端已更新，正在重新核对；本地修改已保留');
  if (!response.ok) throw new Error(payload.error?.message || (response.status === 404 ? '服务端尚未部署新版同步接口，请更新 Cloudflare' : `同步失败 (${response.status})`));
  if (payload.data?.protocol !== 2 || !Number.isSafeInteger(payload.data.revision) || !payload.data.entities?.shortcuts || !payload.data.entities?.folders || !payload.data.entities?.groups) throw new Error('服务端同步格式不兼容，请先更新 Cloudflare');
  return { revision: payload.data.revision, entities: payload.data.entities };
}
async function commitRemote(remote: SyncSnapshot, scope: string, sent: SyncOperation[] = []) {
  return withSyncLock(async () => {
    const { local, journal } = await readLocal();
    if (journal.scope !== scope) throw new Error('同步配置已改变，本次上传停止');
    bootstrap(local, journal, remote);
    const merged = reconcile(local, journal, remote, sent);
    journal.phase = journal.conflicts.length ? 'conflict' : Object.keys(journal.pending).length ? 'pending' : 'synced';
    journal.message = undefined;
    if (journal.phase === 'synced') journal.lastSyncedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE_KEY]: merged, [SYNC_KEY]: journal });
    return journal;
  });
}
export async function runNewtabSync(): Promise<void> {
  // Only one uploader across all extension surfaces. A worker restart releases this lock.
  return navigator.locks.request('tmarks-newtab-network-v2', async () => {
    const config = await credentials();
    const allowed = await withSyncLock(async () => {
      const { journal } = await readLocal();
      if (!config.key) { journal.phase = 'unconfigured'; journal.message = '请在扩展设置中配置 TMarks API Key'; }
      else if (journal.scope && journal.scope !== config.scope) { journal.phase = 'account-changed'; journal.message = '服务器或 API Key 已变更。为避免混入旧账户数据，已暂停同步，请在同步设置中切换。'; }
      else { journal.scope = config.scope; journal.phase = 'syncing'; journal.message = undefined; }
      await chrome.storage.local.set({ [SYNC_KEY]: journal });
      return journal.phase === 'syncing';
    });
    if (!allowed) return;
    try {
      // Pull and compare versions before EVERY upload, including manual upload.
      let journal = await commitRemote(await requestCloud(config), config.scope);
      for (let round = 0; round < 50; round++) {
        if (journal.conflicts.length) return;
        const operations = Object.values(journal.pending).slice(0, 40);
        if (!operations.length) return;
        if ((await credentials()).scope !== config.scope) throw new Error('同步配置已改变，本次上传停止');
        await withSyncLock(async () => {
          const { journal: latest } = await readLocal();
          latest.phase = 'syncing';
          await chrome.storage.local.set({ [SYNC_KEY]: latest });
        });
        try {
          const remote = await requestCloud(config, { revision: journal.remote.revision, operations });
          journal = await commitRemote(remote, config.scope, operations);
        } catch (error) {
          // Recover both CAS races and a lost response: identical mutations are acknowledged on GET.
          journal = await commitRemote(await requestCloud(config), config.scope, operations);
          if (journal.conflicts.length || !Object.keys(journal.pending).length) return;
          if (error instanceof SyncRaceError) continue;
          throw error;
        }
      }
    } catch (error) {
      await withSyncLock(async () => {
        const { journal } = await readLocal();
        if (journal.scope !== config.scope) return;
        journal.phase = 'error';
        journal.message = error instanceof Error ? error.message : '网络不可用，修改已保存在本地，稍后自动重试';
        await chrome.storage.local.set({ [SYNC_KEY]: journal });
      });
    }
  });
}
export async function resolveSyncConflict(key: string, choice: 'local' | 'cloud') {
  await withSyncLock(async () => {
    const { local, journal } = await readLocal();
    const op = journal.pending[key];
    if (!op) return;
    if (choice === 'cloud') {
      delete journal.pending[key];
      if (!journal.remote.entities[op.collection][op.id]) {
        const field = LOCAL_KEYS[op.collection];
        (local as unknown as Record<string, unknown>)[field] = (local[field] || []).filter(item => item.id !== op.id);
      }
    }
    else { op.baseVersion = journal.remote.entities[op.collection][op.id]?.version || 0; op.mutationId = crypto.randomUUID(); }
    const next = reconcile(local, journal, journal.remote);
    journal.phase = journal.conflicts.length ? 'conflict' : 'pending';
    await chrome.storage.local.set({ [STORAGE_KEY]: next, [SYNC_KEY]: journal });
  });
}
export async function switchSyncAccount() {
  await navigator.locks.request('tmarks-newtab-network-v2', () => withSyncLock(async () => {
    const { local, journal } = await readLocal();
    const config = await credentials();
    // Keep a complete recoverable backup, including offline operations and tombstones.
    await chrome.storage.local.set({ [`newtab_account_backup_${Date.now()}`]: { local, journal },
      [STORAGE_KEY]: emptyLocal(), [SYNC_KEY]: { ...newJournal(), scope: config.scope, initialized: true } });
  }));
}
export async function requestImmediateSync() {
  await chrome.runtime.sendMessage({ type: 'NEWTAB_SYNC_NOW' });
}
export { operationKey };
