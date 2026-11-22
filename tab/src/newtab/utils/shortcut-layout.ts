import type { Shortcut, ShortcutFolder } from '../types';

export function getGroupItems(shortcuts: Shortcut[], folders: ShortcutFolder[], groupId: string) {
  return [
    ...folders.filter((item) => (item.groupId || 'home') === groupId).map((item) => ({ ...item, itemType: 'folder' as const })),
    ...shortcuts.filter((item) => !item.folderId && (item.groupId || 'home') === groupId).map((item) => ({ ...item, itemType: 'shortcut' as const })),
  ].sort((a, b) => a.position - b.position);
}

export function nextGroupPosition(shortcuts: Shortcut[], folders: ShortcutFolder[], groupId: string) {
  return Math.max(-1, ...getGroupItems(shortcuts, folders, groupId).map((item) => item.position)) + 1;
}
