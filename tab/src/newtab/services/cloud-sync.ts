import { DEFAULT_GROUPS, DEFAULT_SETTINGS } from '../constants';
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
  const { runNewtabSync, SYNC_KEY } = await import('./sync-engine');
  await runNewtabSync();
  const stored = await chrome.storage.local.get(['newtab', SYNC_KEY]);
  const status = stored[SYNC_KEY] as import('./sync-engine').SyncJournal | undefined;
  if (status?.phase !== 'synced') throw new Error(status?.message || (status?.conflicts?.length ? '存在同步冲突，请在新标签页的同步设置中选择版本' : '还有待上传修改，请在同步设置中查看'));
  return (stored.newtab as NewTabStorage | undefined)?.shortcuts?.length || 0;
}
