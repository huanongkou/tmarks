import { StorageService } from '@/lib/utils/storage';
import { normalizeApiUrl } from '@/lib/constants/urls';
import { DEFAULT_GROUPS, DEFAULT_SETTINGS, STORAGE_KEY } from '../constants';
import type { NewTabStorage, Shortcut } from '../types';

interface CloudDetail {
  id: string;
  title: string;
  url: string;
  favicon?: string;
  position: number;
  createdAt?: string;
  clickCount?: number;
}

export function mergeCloudDetails(local: NewTabStorage | undefined, details: CloudDetail[]): NewTabStorage {
  const shortcuts: Shortcut[] = [...(local?.shortcuts || [])];
  const byUrl = new Map(shortcuts.map((item, index) => [item.url, index]));
  for (const item of details) {
    if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue;
    const existingIndex = byUrl.get(item.url);
    if (existingIndex !== undefined) {
      // 恢复到首页，即使原来的分组或文件夹已经不存在。
      shortcuts[existingIndex] = { ...shortcuts[existingIndex], groupId: 'home', folderId: undefined };
      continue;
    }
    const id = shortcuts.some((shortcut) => shortcut.id === item.id) ? crypto.randomUUID() : item.id;
    shortcuts.push({ id, url: item.url, title: item.title || item.url, favicon: item.favicon,
      position: shortcuts.length, createdAt: Date.parse(item.createdAt || '') || Date.now(),
      clickCount: item.clickCount || 0, groupId: 'home' });
    byUrl.set(item.url, shortcuts.length - 1);
  }
  const groups = [...(local?.shortcutGroups || [])];
  if (!groups.some((group) => group.id === 'home')) groups.unshift({ ...DEFAULT_GROUPS[0] });
  return { ...local, shortcuts, shortcutGroups: groups, shortcutFolders: local?.shortcutFolders || [],
    activeGroupId: 'home', settings: { ...DEFAULT_SETTINGS, ...local?.settings }, gridItems: local?.gridItems || [],
    tmarksSyncedAt: Date.now() };
}

export async function restoreNewtabFromCloud(): Promise<number> {
  const config = await StorageService.getTMarksConfig();
  if (!config.bookmarkApiKey) throw new Error('请先配置 TMarks API Key');
  const response = await fetch(`${normalizeApiUrl(config.bookmarkApiUrl)}/tab/newtab/sync`, {
    headers: { 'X-API-Key': config.bookmarkApiKey }, signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `新标签页恢复失败 (${response.status})`);
  if (!Array.isArray(payload.data?.shortcuts) || payload.data.recovery_version !== 1) {
    throw new Error('服务端尚未更新，请等待 Cloudflare 部署完成后重试');
  }
  // 请求完成后再读取本地，合并请求期间新增的快捷方式。
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const data = mergeCloudDetails(stored[STORAGE_KEY] as NewTabStorage | undefined, payload.data.shortcuts);
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  return payload.data.shortcuts.length;
}
