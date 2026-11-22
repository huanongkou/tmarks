import { useNewtabStore } from '../hooks/useNewtabStore';
import { downloadFavicon } from '../utils/favicon';
import { pickLibraryIcon } from '../utils/icon-library';

export function saveShortcutEdits(id: string, url: string, title: string, note: string) {
  const state = useNewtabStore.getState();
  const current = state.shortcuts.find((item) => item.id === id);
  if (!current) return;
  const iconUpdates = url !== current.url ? { faviconBase64: undefined, favicon: undefined, fallbackIcon: undefined, fallbackColor: undefined } : {};
  state.updateShortcut(id, { url, title, note, ...iconUpdates });
}

export async function refreshShortcutIcon(id: string): Promise<boolean> {
  const state = useNewtabStore.getState();
  const shortcut = state.shortcuts.find((item) => item.id === id);
  if (!shortcut) return false;
  let domain: string;
  try { domain = new URL(shortcut.url).hostname; } catch {
    state.updateShortcut(id, { faviconBase64: undefined, ...pickLibraryIcon() });
    return false;
  }
  state.updateShortcut(id, { faviconBase64: undefined,
    favicon: `https://www.google.com/s2/favicons?domain=${domain}&sz=64&_refresh=${Date.now()}` });
  const faviconBase64 = await downloadFavicon(shortcut.url, 10, true);
  const latest = useNewtabStore.getState();
  // 下载期间可能编辑了地址或删除了快捷方式，不把旧图标写回。
  if (!latest.shortcuts.some((item) => item.id === id && item.url === shortcut.url)) return false;
  if (faviconBase64) latest.updateShortcut(id, { faviconBase64, fallbackIcon: undefined, fallbackColor: undefined });
  else latest.updateShortcut(id, { faviconBase64: undefined, ...pickLibraryIcon() });
  return Boolean(faviconBase64);
}
