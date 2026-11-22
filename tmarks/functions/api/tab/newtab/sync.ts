/**
 * NewTab 明细恢复与增量备份。分组丢失时仍可恢复网址；上传不删除云端数据。
 */
import type { PagesFunction } from '@cloudflare/workers-types'
import type { Env, RouteParams } from '../../../lib/types'
import { success, badRequest, internalError } from '../../../lib/response'
import { requireApiKeyAuth, ApiKeyAuthContext } from '../../../middleware/api-key-auth-pages'
import { isValidUrl, sanitizeString } from '../../../lib/validation'
import { generateUUID } from '../../../lib/crypto'

interface DetailRow {
  id: string
  title: string
  url: string
  favicon: string | null
  position: number
  created_at: string
  click_count?: number
}

interface ShortcutInput {
  id?: string
  title: string
  url: string
  favicon?: string
  position: number
}

export const onRequestGet: PagesFunction<Env, RouteParams, ApiKeyAuthContext>[] = [
  requireApiKeyAuth('bookmarks.read'),
  async (context) => {
    const userId = context.data.user_id
    try {
      // 不关联分组表，保留失去分组的明细。旧版网格中的网址也需要恢复。
      const [shortcuts, gridItems] = await Promise.all([
        context.env.DB.prepare(
          'SELECT id, title, url, favicon, position, created_at, click_count FROM newtab_shortcuts WHERE user_id = ? ORDER BY position ASC, id ASC'
        ).bind(userId).all<DetailRow>(),
        context.env.DB.prepare(
          `SELECT id, shortcut_title AS title, shortcut_url AS url, shortcut_favicon AS favicon, position, created_at
           FROM newtab_grid_items WHERE user_id = ? AND shortcut_url IS NOT NULL AND shortcut_url != ''
           ORDER BY position ASC, id ASC`
        ).bind(userId).all<DetailRow>(),
      ])
      const seen = new Set<string>()
      const details = [...(shortcuts.results || []), ...(gridItems.results || [])]
        .filter((item) => {
          if (!isValidUrl(item.url) || seen.has(item.url)) return false
          seen.add(item.url)
          return true
        })
        .map((item, position) => ({
          id: item.id,
          title: item.title || item.url,
          url: item.url,
          favicon: item.favicon,
          position,
          groupId: 'home',
          createdAt: item.created_at,
          clickCount: item.click_count || 0,
        }))
      return success({ shortcuts: details, groups: [], recovery_version: 1 })
    } catch (error) {
      console.error('Get sync data error:', error)
      return internalError('Failed to load NewTab details')
    }
  },
]

export const onRequestPost: PagesFunction<Env, RouteParams, ApiKeyAuthContext>[] = [
  requireApiKeyAuth('bookmarks.create'),
  async (context) => {
    const userId = context.data.user_id
    try {
      const body = await context.request.json() as { shortcuts?: ShortcutInput[] }
      if (!body || !Array.isArray(body.shortcuts)) return badRequest('shortcuts array is required')
      // 在写入前验证整个请求，空数组仅作为无操作处理。
      if (body.shortcuts.some((item) => !item || typeof item.title !== 'string' ||
        typeof item.url !== 'string' || !isValidUrl(item.url) || !Number.isFinite(item.position) ||
        (item.id !== undefined && (typeof item.id !== 'string' || !item.id)))) {
        return badRequest('Invalid shortcut details')
      }
      const now = new Date().toISOString()
      const statements = body.shortcuts.map((item) => context.env.DB.prepare(
        `INSERT INTO newtab_shortcuts (id, user_id, title, url, favicon, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, url = excluded.url,
           favicon = COALESCE(excluded.favicon, newtab_shortcuts.favicon),
           position = excluded.position, updated_at = excluded.updated_at
         WHERE newtab_shortcuts.user_id = excluded.user_id`
      ).bind(item.id || generateUUID(), userId, sanitizeString(item.title, 200),
        item.url, typeof item.favicon === 'string' ? sanitizeString(item.favicon, 2000) : null,
        item.position, now, now))
      if (statements.length) await context.env.DB.batch(statements)
      return success({ message: 'Details backed up without deleting cloud data', synced_at: now })
    } catch (error) {
      console.error('Sync data error:', error)
      return internalError('Failed to back up NewTab details')
    }
  },
]
