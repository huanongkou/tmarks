import { DEFAULT_GROUPS, DEFAULT_SETTINGS } from '../constants';
import type { NewTabStorage } from '../types';
import { SYNC_COLLECTIONS, emptyEntities, operationKey, recordValue, sameValue, syncValue,
  type SyncCollection, type SyncOperation, type SyncSnapshot, type SyncConflict, type SyncValue } from '../../../../tmarks/shared/newtab-sync';
export { SYNC_COLLECTIONS, operationKey, recordValue, sameValue, syncValue };
export type { SyncOperation, SyncSnapshot, SyncConflict, SyncValue };
export const SYNC_KEY = 'newtab_sync_v2';
export const LOCAL_KEYS = { groups: 'shortcutGroups', folders: 'shortcutFolders', shortcuts: 'shortcuts' } as const;
export interface SyncJournal {
  scope?: string;
  initialized: boolean;
  remote: SyncSnapshot;
  pending: Record<string, SyncOperation>;
  conflicts: SyncConflict[];
  phase: 'idle' | 'pending' | 'syncing' | 'synced' | 'error' | 'conflict' | 'unconfigured' | 'account-changed';
  message?: string;
  lastSyncedAt?: number;
}
export const newJournal = (): SyncJournal => ({ initialized: false, remote: { revision: 0, entities: emptyEntities() }, pending: {}, conflicts: [], phase: 'idle' });
export const emptyLocal = (): NewTabStorage => ({ shortcuts: [], shortcutGroups: structuredClone(DEFAULT_GROUPS), shortcutFolders: [], activeGroupId: 'home', settings: structuredClone(DEFAULT_SETTINGS), gridItems: [] });
export function queueValue(journal: SyncJournal, collection: SyncCollection, id: string, value: SyncValue | null, baseVersion?: number) {
  const key = operationKey(collection, id);
  const old = journal.pending[key];
  // Keep an operation even when it reverts to the last known cloud value: an earlier
  // upload may still be in flight and must be undone after its acknowledgement.
  journal.pending[key] = { collection, id, value, baseVersion: old?.baseVersion ?? baseVersion ?? journal.remote.entities[collection][id]?.version ?? 0, mutationId: crypto.randomUUID() };
}
// Diff against this tab's previous view, then apply only the changed fields to the
// latest persisted data. A stale tab must never infer deletion from another tab's additions.
export function persistPatch(previous: NewTabStorage, next: NewTabStorage, latest: NewTabStorage, journal: SyncJournal, viewRemote?: SyncSnapshot): NewTabStorage {
  const merged = structuredClone(latest);
  for (const collection of SYNC_COLLECTIONS) {
    const field = LOCAL_KEYS[collection];
    const before = new Map((previous[field] || []).map(item => [item.id, item]));
    const after = new Map((next[field] || []).map(item => [item.id, item]));
    const rows = new Map<string, Record<string, unknown>>((latest[field] || []).map(item => [item.id, { ...item }]));
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(id) as unknown as Record<string, unknown> | undefined;
      const b = after.get(id) as unknown as Record<string, unknown> | undefined;
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (!b) { rows.delete(id); queueValue(journal, collection, id, null, viewRemote ? viewRemote.entities[collection][id]?.version || 0 : undefined); continue; }
      const row = rows.get(id);
      // An obsolete tab editing a remotely deleted item requires explicit conflict resolution.
      const value: Record<string, unknown> = { ...(row || a || b) };
      for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b)])) {
        if (JSON.stringify(a?.[key]) !== JSON.stringify(b[key])) value[key] = b[key];
      }
      rows.set(id, value);
      const canonical = syncValue(collection, value);
      if (!sameValue(a ? syncValue(collection, a) : null, syncValue(collection, b))) queueValue(journal, collection, id, canonical, viewRemote ? viewRemote.entities[collection][id]?.version || 0 : undefined);
    }
    (merged as unknown as Record<string, unknown>)[field] = collection === 'groups' ? [...rows.values()].sort((a, b) => Number(a.position || 0) - Number(b.position || 0)) : [...rows.values()];
  }
  for (const field of ['activeGroupId', 'gridItems'] as const) {
    if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) (merged as unknown as Record<string, unknown>)[field] = next[field];
  }
  for (const key of Object.keys(next.settings) as (keyof NewTabStorage['settings'])[]) {
    if (JSON.stringify(previous.settings[key]) !== JSON.stringify(next.settings[key])) Object.assign(merged.settings, { [key]: next.settings[key] });
  }
  if (Object.keys(journal.pending).length) journal.phase = 'pending';
  return merged;
}
export function bootstrap(local: NewTabStorage, journal: SyncJournal, remote: SyncSnapshot) {
  if (journal.initialized) return;
  for (const collection of SYNC_COLLECTIONS) for (const item of (local[LOCAL_KEYS[collection]] || [])) {
    const key = operationKey(collection, item.id);
    if (journal.pending[key]) continue;
    const value = syncValue(collection, item as unknown as Record<string, unknown>);
    const cloud = remote.entities[collection][item.id];
    if (sameValue(recordValue(cloud), value)) continue;
    // The factory Home group is not a user rename; prefer the existing cloud Home.
    if (collection === 'groups' && item.id === 'home' && sameValue(value, syncValue('groups', { ...DEFAULT_GROUPS[0] }))) continue;
    queueValue(journal, collection, item.id, value);
  }
  journal.initialized = true;
}
export function reconcile(local: NewTabStorage, journal: SyncJournal, remote: SyncSnapshot, sent: SyncOperation[] = []): NewTabStorage {
  if (remote.revision < journal.remote.revision) return local;
  for (const op of sent) {
    const key = operationKey(op.collection, op.id);
    const current = journal.pending[key];
    const ack = remote.entities[op.collection][op.id];
    if (!current || !(ack?.mutationId === op.mutationId || sameValue(recordValue(ack), op.value))) continue;
    if (current.mutationId === op.mutationId) delete journal.pending[key];
    else current.baseVersion = ack?.version || 0;
  }
  journal.remote = remote;
  journal.conflicts = [];
  for (const [key, op] of Object.entries(journal.pending)) {
    const cloud = remote.entities[op.collection][op.id];
    if (sameValue(recordValue(cloud), op.value)) { delete journal.pending[key]; continue; }
    if ((cloud?.version || 0) !== op.baseVersion) journal.conflicts.push({ collection: op.collection, id: op.id, local: op, remote: cloud });
  }
  const next = structuredClone(local);
  for (const collection of SYNC_COLLECTIONS) {
    const rows = new Map((local[LOCAL_KEYS[collection]] || []).map(item => [item.id, item]));
    for (const [id, record] of Object.entries(remote.entities[collection])) {
      if (journal.pending[operationKey(collection, id)]) continue;
      if (record.deleted) rows.delete(id);
      else rows.set(id, { ...(collection === 'shortcuts' ? { clickCount: (rows.get(id) as { clickCount?: number })?.clickCount || 0, createdAt: Date.now() } : {}), ...record.value } as never);
    }
    // Apply pending values as well (e.g. a restored local deletion).
    for (const op of Object.values(journal.pending).filter(op => op.collection === collection)) {
      if (!op.value) rows.delete(op.id);
      else rows.set(op.id, { ...(collection === 'shortcuts' ? { clickCount: (rows.get(op.id) as { clickCount?: number })?.clickCount || 0, createdAt: Date.now() } : {}), ...op.value } as never);
    }
    (next as unknown as Record<string, unknown>)[LOCAL_KEYS[collection]] = [...rows.values()].sort((a, b) => a.position - b.position);
  }
  if (!next.shortcutGroups.some(g => g.id === 'home')) next.shortcutGroups.unshift({ ...DEFAULT_GROUPS[0] });
  const groupIds = new Set(next.shortcutGroups.map(g => g.id));
  next.shortcutFolders = (next.shortcutFolders || []).map(f => ({ ...f, groupId: groupIds.has(f.groupId || 'home') ? f.groupId : 'home' }));
  const folders = new Map(next.shortcutFolders.map(f => [f.id, f]));
  next.shortcuts = next.shortcuts.map(s => ({ ...s, groupId: folders.get(s.folderId || '')?.groupId || (groupIds.has(s.groupId || 'home') ? s.groupId : 'home'), folderId: folders.has(s.folderId || '') ? s.folderId : undefined }));
  if (!next.shortcutGroups.some(g => g.id === next.activeGroupId)) next.activeGroupId = 'home';
  return next;
}
