import { hasPermission } from '../../../../shared/permissions'
import type { Env } from '../../../lib/types'
import { requireApiKeyAuth, type ApiKeyAuthContext } from '../../../middleware/api-key-auth-pages'
import { badRequest, internalError, success } from '../../../lib/response'
import { applyOperations, emptyEntities, syncValue, validateOperation, type SyncSnapshot, type SyncOperation, type SyncCollection } from '../../../../shared/newtab-sync'

type SyncContext = { env: Env; data: ApiKeyAuthContext; request: Request }
type Row = Record<string, string | number | null>
async function ensureSchema(db: D1Database) {
  // 幂等建表，已部署的实例也能升级；不修改或删除旧表。
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS newtab_sync_state (user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS newtab_sync_history (user_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, revision))'),
  ])
}
async function readState(db: D1Database, userId: string): Promise<SyncSnapshot> {
  const row = await db.prepare('SELECT revision, payload FROM newtab_sync_state WHERE user_id = ?').bind(userId).first<{ revision: number; payload: string }>()
  if (row) return { revision: row.revision, entities: JSON.parse(row.payload) }
  const [groups, folders, shortcuts, grid] = await Promise.all([
    db.prepare('SELECT * FROM newtab_groups WHERE user_id = ? ORDER BY position, id').bind(userId).all<Row>(),
    db.prepare('SELECT * FROM newtab_folders WHERE user_id = ? ORDER BY position, id').bind(userId).all<Row>(),
    db.prepare('SELECT * FROM newtab_shortcuts WHERE user_id = ? ORDER BY position, id').bind(userId).all<Row>(),
    db.prepare("SELECT * FROM newtab_grid_items WHERE user_id = ? AND shortcut_url IS NOT NULL AND shortcut_url != '' ORDER BY position, id").bind(userId).all<Row>(),
  ])
  const entities = emptyEntities()
  const add = (collection: SyncCollection, value: Record<string, unknown>) => {
    if (!value.id || (value.id === 'prototype' || Object.prototype.hasOwnProperty.call(Object.prototype, String(value.id)))) return
    if (collection === 'shortcuts') {
      try { if (!['http:', 'https:'].includes(new URL(String(value.url)).protocol)) return } catch { return }
      value.title = value.title || value.url
    }
    const normalized = syncValue(collection, value)
    entities[collection][String(value.id)] = { value: normalized, version: 1 }
  }
  for (const item of groups.results || []) add('groups', item)
  if (!entities.groups.home) add('groups', { id: 'home', name: '首页', icon: 'Home', position: 0 })
  for (const item of folders.results || []) add('folders', { ...item,
    groupId: entities.groups[String(item.group_id)] ? item.group_id : 'home', createdAt: Date.parse(String(item.created_at)) || Date.now() })
  for (const item of shortcuts.results || []) add('shortcuts', { ...item,
    groupId: entities.groups[String(item.group_id)] ? item.group_id : 'home',
    folderId: entities.folders[String(item.folder_id)] ? item.folder_id : undefined,
    createdAt: Date.parse(String(item.created_at)) || Date.now() })
  const urls = new Set(Object.values(entities.shortcuts).map(item => item.value.url))
  for (const item of grid.results || []) {
    if (urls.has(String(item.shortcut_url))) continue
    urls.add(String(item.shortcut_url))
    add('shortcuts', { id: entities.shortcuts[String(item.id)] ? `legacy-grid:${item.id}` : item.id,
      title: item.shortcut_title || item.shortcut_url, url: item.shortcut_url, favicon: item.shortcut_favicon,
      position: item.position, groupId: entities.groups[String(item.group_id)] ? item.group_id : 'home',
      createdAt: Date.parse(String(item.created_at)) || Date.now() })
  }
  await db.prepare('INSERT OR IGNORE INTO newtab_sync_state (user_id, revision, payload, updated_at) VALUES (?, 1, ?, ?)')
    .bind(userId, JSON.stringify(entities), new Date().toISOString()).run()
  // 并发初始化只采用成功写入的状态，避免旧表更新造成读写不一致。
  return readState(db, userId)
}
export const onRequestGet = [
  requireApiKeyAuth('bookmarks.read'), async (context: SyncContext) => {
    try {
      await ensureSchema(context.env.DB)
      return success({ protocol: 2, userId: context.data.user_id, ...await readState(context.env.DB, context.data.user_id) })
    } catch (error) { console.error('NewTab sync read failed', error); return internalError('读取同步数据失败，请检查 NewTab 数据表是否已初始化') }
  },
]
export const onRequestPost = [
  requireApiKeyAuth('bookmarks.create'), async (context: SyncContext) => {
    try {
      if (Number(context.request.headers.get('Content-Length') || 0) > 4 * 1024 * 1024) return badRequest('单次同步数据过大')
      const text = await context.request.text()
      if (text.length > 4 * 1024 * 1024) return badRequest('单次同步数据过大')
      let body: { revision: number; operations: SyncOperation[] }
      try { body = JSON.parse(text) } catch { return badRequest('无效的 JSON') }
      if (!body || typeof body !== 'object') return badRequest('无效的同步操作')
      if (!Number.isSafeInteger(body.revision) || !Array.isArray(body.operations) || body.operations.length > 100 || !body.operations.every(validateOperation)) return badRequest('无效的同步操作')
      if (new Set(body.operations.map(op => `${op.collection}:${op.id}`)).size !== body.operations.length) return badRequest('包含重复同步操作')
      // 删除需要单独的删除权限，不能仅凭写入权限删除。
      if (body.operations.some(op => op.value === null) && !hasPermission(context.data.api_key_permissions, 'bookmarks.delete')) {
        return Response.json({ error: { message: '同步删除需要 bookmarks.delete 权限' } }, { status: 403 })
      }
      await ensureSchema(context.env.DB)
      const snapshot = await readState(context.env.DB, context.data.user_id)
      const result = applyOperations(snapshot, body.operations)
      if (result.conflicts.length) return Response.json({ data: { protocol: 2, ...snapshot, conflicts: result.conflicts } }, { status: 409 })
      if (body.operations.some(op => op.value !== null && snapshot.entities[op.collection][op.id] && !hasPermission(context.data.api_key_permissions, 'bookmarks.update'))) return Response.json({ error: { message: '同步修改需要 bookmarks.update 权限' } }, { status: 403 })
      if (result.snapshot.revision === snapshot.revision) return success({ protocol: 2, ...snapshot })
      const serialized = JSON.stringify(result.snapshot.entities)
      if (new TextEncoder().encode(serialized).byteLength > 1800000) return badRequest('同步数据超过当前容量（约 1.8 MB），请减少缓存图标大小后重试。本地修改和云端原数据均已保留。')
      const now = new Date().toISOString()
      // 历史保存和版本 CAS 在同一个事务中执行。并发请求只能有一个更新成功。
      const batch = await context.env.DB.batch([
        context.env.DB.prepare('INSERT OR IGNORE INTO newtab_sync_history (user_id, revision, payload, created_at) SELECT user_id, revision, payload, ? FROM newtab_sync_state WHERE user_id = ? AND revision = ?')
          .bind(now, context.data.user_id, snapshot.revision),
        context.env.DB.prepare('UPDATE newtab_sync_state SET revision = ?, payload = ?, updated_at = ? WHERE user_id = ? AND revision = ? RETURNING revision')
          .bind(result.snapshot.revision, serialized, now, context.data.user_id, snapshot.revision),
      ])
      if (!batch[1].results.length) return Response.json({ error: { message: '云端刚有更新，请重试' } }, { status: 409 })
      return success({ protocol: 2, ...result.snapshot })
    } catch (error) { console.error('NewTab sync write failed', error); return internalError('同步未完成，修改已保存在本地，请重试') }
  },
]
