export const SYNC_COLLECTIONS = ['groups', 'folders', 'shortcuts'] as const
export type SyncCollection = typeof SYNC_COLLECTIONS[number]
export type SyncValue = Record<string, string | number | undefined>
export interface SyncRecord { value: SyncValue; version: number; deleted?: boolean; mutationId?: string }
export type SyncEntities = Record<SyncCollection, Record<string, SyncRecord>>
export interface SyncSnapshot { revision: number; entities: SyncEntities }
export interface SyncOperation {
  collection: SyncCollection; id: string; value: SyncValue | null; baseVersion: number; mutationId: string
}
export interface SyncConflict { collection: SyncCollection; id: string; local: SyncOperation; remote?: SyncRecord }
export const emptyEntities = (): SyncEntities => ({ groups: {}, folders: {}, shortcuts: {} })
export function sameValue(a: SyncValue | null | undefined, b: SyncValue | null | undefined): boolean {
  if (!a || !b) return a === b
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
  return keys.every(key => (a[key] ?? undefined) === (b[key] ?? undefined))
}
export function recordValue(record?: SyncRecord): SyncValue | null { return record && !record.deleted ? record.value : null }
export function operationKey(collection: SyncCollection, id: string) { return `${collection}:${id}` }
const fields: Record<SyncCollection, string[]> = {
  groups: ['id', 'name', 'icon', 'position'],
  folders: ['id', 'name', 'icon', 'position', 'groupId', 'createdAt'],
  shortcuts: ['id', 'title', 'url', 'note', 'groupId', 'folderId', 'position', 'favicon', 'faviconBase64', 'fallbackIcon', 'fallbackColor', 'createdAt'],
}
export function syncValue(collection: SyncCollection, input: Record<string, unknown>): SyncValue {
  const result: SyncValue = {}
  for (const key of fields[collection]) {
    const value = input[key]
    if (typeof value === 'string' || typeof value === 'number') result[key] = value
  }
  if (collection !== 'groups') result.groupId = result.groupId || 'home'
  if (collection === 'shortcuts') {
    result.note = result.note || ''
    if (!result.folderId) delete result.folderId
  }
  return result
}
export function validateOperation(input: unknown): input is SyncOperation {
  if (!input || typeof input !== 'object') return false
  const op = input as SyncOperation
  if (!SYNC_COLLECTIONS.includes(op.collection) || typeof op.id !== 'string' || !op.id || op.id.length > 200 || (op.id === 'prototype' || Object.prototype.hasOwnProperty.call(Object.prototype, op.id)) ||
    !Number.isSafeInteger(op.baseVersion) || op.baseVersion < 0 || typeof op.mutationId !== 'string' || !op.mutationId || op.mutationId.length > 200) return false
  if (op.value === null) return !(op.collection === 'groups' && op.id === 'home')
  if (!op.value || typeof op.value !== 'object' || Array.isArray(op.value) || op.value.id !== op.id) return false
  const value = op.value
  if (!Number.isFinite(value.position) || Number(value.position) < 0) return false
  if (Object.entries(value).some(([key, v]) => !fields[op.collection].includes(key) ||
    (typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'number' && !Number.isFinite(v)) ||
    (typeof v === 'string' && v.length > (key === 'faviconBase64' ? 65536 : key === 'note' ? 2000 : 4096)))) return false
  if (Object.entries(value).some(([key, v]) => ['position', 'createdAt'].includes(key) ? typeof v !== 'number' : typeof v !== 'string')) return false
  if (op.collection === 'shortcuts') {
    if (typeof value.title !== 'string' || !value.title.trim() || typeof value.url !== 'string') return false
    try { if (!['http:', 'https:'].includes(new URL(value.url).protocol)) return false } catch { return false }
    if (value.faviconBase64 && !/^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon|svg\+xml);base64,/i.test(String(value.faviconBase64))) return false
  } else if (typeof value.name !== 'string' || !value.name.trim()) return false
  return true
}
export function applyOperations(snapshot: SyncSnapshot, operations: SyncOperation[]) {
  const conflicts: SyncConflict[] = []
  for (const op of operations) {
    const remote = snapshot.entities[op.collection][op.id]
    if (remote?.mutationId === op.mutationId || sameValue(recordValue(remote), op.value)) continue
    if ((remote?.version || 0) !== op.baseVersion) conflicts.push({ collection: op.collection, id: op.id, local: op, remote })
  }
  if (conflicts.length) return { conflicts, snapshot }
  if (operations.every(op => snapshot.entities[op.collection][op.id]?.mutationId === op.mutationId || sameValue(recordValue(snapshot.entities[op.collection][op.id]), op.value))) return { conflicts, snapshot }
  const next = structuredClone(snapshot)
  next.revision++
  for (const op of operations) {
    const previous = next.entities[op.collection][op.id]
    if (previous?.mutationId === op.mutationId || sameValue(recordValue(previous), op.value)) continue
    next.entities[op.collection][op.id] = { value: op.value || previous?.value || { id: op.id },
      version: next.revision, deleted: op.value === null, mutationId: op.mutationId }
  }
  return { conflicts, snapshot: next }
}
