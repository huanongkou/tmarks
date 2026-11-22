/**
 * NewTab 状态管理
 */

import { create } from 'zustand';
import { getGroupItems, nextGroupPosition } from '../utils/shortcut-layout';
import type { Shortcut, ShortcutGroup, ShortcutFolder, NewTabSettings, NewTabStorage, GridItem, GridItemType, GridItemSize } from '../types';
import { DEFAULT_SETTINGS, STORAGE_KEY, DEFAULT_GROUPS } from '../constants';
import { saveLocalPatch } from '../services/sync-engine';
import { emptyLocal, newJournal, SYNC_KEY, type SyncSnapshot, type SyncJournal } from '../services/sync-journal';
import { getWidgetMeta, getDefaultWidgetConfig } from '../components/widgets/widgetRegistry';

let previousView = emptyLocal();
let previousRemote: SyncSnapshot = newJournal().remote;
let previousScope: string | undefined;
let writeRevision = 0;
let loadRevision = 0;
let pendingWrites: Promise<unknown> = Promise.resolve();

interface NewTabState {
  // 数据
  shortcuts: Shortcut[];
  shortcutGroups: ShortcutGroup[];
  shortcutFolders: ShortcutFolder[];
  activeGroupId: string | null;
  settings: NewTabSettings;
  isLoading: boolean;
  gridItems: GridItem[];

  // 仅用于拖拽交互，不持久化
  draggingShortcutId: string | null;

  // Actions
  loadData: () => Promise<void>;
  saveData: () => Promise<void>;

  // 快捷方式操作
  addShortcut: (shortcut: Omit<Shortcut, 'id' | 'position' | 'createdAt' | 'clickCount'>) => void;
  updateShortcut: (id: string, updates: Partial<Shortcut>) => void;
  removeShortcut: (id: string) => void;
  moveShortcutToGroup: (shortcutId: string, groupId: string) => void;
  reorderShortcuts: (fromIndex: number, toIndex: number) => void;
  reorderGroupItems: (activeId: string, targetId: string) => void;
  incrementClickCount: (id: string) => void;

  // 分组操作
  setActiveGroup: (groupId: string | null) => void;
  addGroup: (name: string, icon: string) => void;
  updateGroup: (id: string, updates: Partial<ShortcutGroup>) => void;
  reorderGroups: (activeId: string, targetId: string) => void;
  removeGroup: (id: string) => void;
  getFilteredShortcuts: () => Shortcut[];

  // 文件夹操作
  addFolder: (name: string, groupId?: string) => string;
  updateFolder: (id: string, updates: Partial<ShortcutFolder>) => void;
  removeFolder: (id: string) => void;
  getFolderShortcuts: (folderId: string) => Shortcut[];
  moveShortcutToFolder: (shortcutId: string, folderId: string | undefined) => void;

  // 设置操作
  updateSettings: (updates: Partial<NewTabSettings>) => void;

  // 网格项操作
  addGridItem: (type: GridItemType, options?: { size?: GridItemSize; groupId?: string; shortcut?: GridItem['shortcut'] }) => void;
  updateGridItem: (id: string, updates: Partial<GridItem>) => void;
  removeGridItem: (id: string) => void;
  reorderGridItems: (fromIndex: number, toIndex: number) => void;
  getFilteredGridItems: () => GridItem[];
  migrateToGridItems: () => void;
}

// 生成唯一 ID
const generateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const useNewtabStore = create<NewTabState>((set, get) => ({
  shortcuts: [],
  shortcutGroups: DEFAULT_GROUPS,
  shortcutFolders: [],
  activeGroupId: 'home', // 默认选中首页
  settings: DEFAULT_SETTINGS,
  isLoading: true,
  gridItems: [],
  draggingShortcutId: null,

  loadData: async () => {
    try {
      const loadRequest = ++loadRevision;
      await pendingWrites;
      const readRevision = writeRevision;
      const result = await chrome.storage.local.get([STORAGE_KEY, SYNC_KEY]);
      if (loadRequest !== loadRevision) return;
      if (readRevision !== writeRevision) return get().loadData();
      const data = result[STORAGE_KEY] as NewTabStorage | undefined;

      // 确保分组数据有效
      const groups = data?.shortcutGroups?.length ? data.shortcutGroups : DEFAULT_GROUPS;

      // 验证 activeGroupId 是否有效，如果无效则使用第一个分组
      let activeGroupId = data?.activeGroupId;
      if (!activeGroupId || !groups.some(g => g.id === activeGroupId)) {
        activeGroupId = groups[0]?.id || 'home';
      }

      // 合并设置，确保新增的设置项有默认值
      const settings = { ...DEFAULT_SETTINGS, ...(data?.settings || {}) };

      previousScope = (result[SYNC_KEY] as SyncJournal | undefined)?.scope;
      previousRemote = (result[SYNC_KEY] as SyncJournal | undefined)?.remote || newJournal().remote;
      previousView = structuredClone({ ...emptyLocal(), ...data, shortcutGroups: groups, settings });
      set({
        shortcuts: data?.shortcuts || [],
        shortcutGroups: groups,
        shortcutFolders: data?.shortcutFolders || [],
        activeGroupId,
        settings,
        gridItems: data?.gridItems || [],
        isLoading: false,
      });

      // 如果是首次加载（没有数据），保存默认数据
      if (!data) {
        const { saveData } = get();
        saveData();
      }
    } catch (error) {
      console.error('Failed to load newtab data:', error);
      set({ isLoading: false });
    }
  },

  saveData: async () => {
    const { shortcuts, shortcutGroups, shortcutFolders, activeGroupId, settings, gridItems } = get();
    const data: NewTabStorage = { shortcuts, shortcutGroups, shortcutFolders, activeGroupId, settings, gridItems };

    try {
      writeRevision++;
      const before = previousView;
      const viewRemote = previousRemote;
      const viewScope = previousScope;
      previousView = structuredClone(data);
      pendingWrites = pendingWrites.catch(() => {}).then(() => saveLocalPatch(before, data, viewRemote, viewScope));
      await pendingWrites;
    } catch (error) {
      console.error('Failed to save newtab data:', error);
      void get().loadData();
    }
  },

  addShortcut: (shortcut) => {
    const { shortcuts, saveData } = get();
    const newShortcut: Shortcut = {
      ...shortcut,
      id: generateId(),
      position: nextGroupPosition(shortcuts, get().shortcutFolders, shortcut.groupId || 'home'),
      createdAt: Date.now(),
      clickCount: 0,
    };

    const newShortcuts = [...shortcuts, newShortcut];
    set({ shortcuts: newShortcuts });
    saveData();

    // 异步下载并缓存 favicon
    (async () => {
      try {
        const { downloadFavicon } = await import('../utils/favicon');
        const base64 = await downloadFavicon(newShortcut.url);
        if (base64 && get().shortcuts.some((item) => item.id === newShortcut.id && item.url === newShortcut.url)) {
          const { updateShortcut } = get();
          updateShortcut(newShortcut.id, { faviconBase64: base64 });
        }
      } catch (error) {
        console.error('Failed to cache favicon:', error);
      }
    })();

    // 异步同步到后端（防抖）

  },

  updateShortcut: (id, updates) => {
    const { shortcuts, saveData } = get();
    const newShortcuts = shortcuts.map((s) => (s.id === id ? { ...s, ...updates } : s));
    set({ shortcuts: newShortcuts });
    saveData();
  },

  moveShortcutToGroup: (shortcutId, groupId) => {
    const { shortcuts, shortcutGroups, updateShortcut } = get();
    const shortcut = shortcuts.find((item) => item.id === shortcutId);
    if (!shortcut || !shortcutGroups.some((group) => group.id === groupId)) return;
    if ((shortcut.groupId || 'home') === groupId && !shortcut.folderId) return;
    const position = nextGroupPosition(shortcuts, get().shortcutFolders, groupId);
    updateShortcut(shortcutId, { groupId, folderId: undefined, position });
  },

  removeShortcut: (id) => {
    const { shortcuts, saveData } = get();
    const filtered = shortcuts.filter((s) => s.id !== id);
    const reordered = filtered;
    set({ shortcuts: reordered });
    saveData();
  },

  reorderGroupItems: (activeId, targetId) => {
    const { shortcuts, shortcutFolders, activeGroupId, saveData } = get();
    const items = getGroupItems(shortcuts, shortcutFolders, activeGroupId || 'home');
    const from = items.findIndex((item) => item.id === activeId);
    const to = items.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    const positions = new Map(items.map((item, position) => [item.id, position]));
    const nextShortcuts = shortcuts.map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item);
    const nextFolders = shortcutFolders.map((item) => positions.has(item.id) ? { ...item, position: positions.get(item.id)! } : item);
    set({ shortcuts: nextShortcuts, shortcutFolders: nextFolders });
    void saveData();
  },

  reorderShortcuts: (fromIndex, toIndex) => {
    const { shortcuts, saveData } = get();
    const newShortcuts = [...shortcuts];
    const [removed] = newShortcuts.splice(fromIndex, 1);
    newShortcuts.splice(toIndex, 0, removed);
    const reordered = newShortcuts.map((s, index) => ({ ...s, position: index }));
    set({ shortcuts: reordered });
    saveData();
  },

  incrementClickCount: (id) => {
    const { shortcuts, saveData } = get();
    set({
      shortcuts: shortcuts.map((s) =>
        s.id === id ? { ...s, clickCount: s.clickCount + 1 } : s
      ),
    });
    saveData();
  },

  updateSettings: (updates) => {
    const { settings, saveData } = get();
    const newSettings = { ...settings, ...updates };
    set({ settings: newSettings });
    saveData();
  },

  // 分组操作
  setActiveGroup: (groupId) => {
    const { saveData } = get();
    set({ activeGroupId: groupId });
    saveData();
    // 不需要同步 activeGroupId，这是本地状态
  },

  addGroup: (name, icon) => {
    const { shortcutGroups, saveData } = get();
    const newGroup: ShortcutGroup = {
      id: generateId(),
      name,
      icon,
      position: shortcutGroups.length,
    };
    const newGroups = [...shortcutGroups, newGroup];
    set({ shortcutGroups: newGroups });
    saveData();
  },

  updateGroup: (id, updates) => {
    const { shortcutGroups, saveData } = get();
    const newGroups = shortcutGroups.map((g) => (g.id === id ? { ...g, ...updates } : g));
    set({ shortcutGroups: newGroups });
    saveData();
  },

  reorderGroups: (activeId, targetId) => {
    const { shortcutGroups, saveData } = get();
    const from = shortcutGroups.findIndex((group) => group.id === activeId);
    const to = shortcutGroups.findIndex((group) => group.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const groups = [...shortcutGroups];
    const [moved] = groups.splice(from, 1);
    groups.splice(to, 0, moved);
    set({ shortcutGroups: groups.map((group, position) => ({ ...group, position })) });
    void saveData();
  },

  removeGroup: (id) => {
    const { shortcutGroups, shortcutFolders, shortcuts, activeGroupId, saveData } = get();
    // 不允许删除首页分组
    if (id === 'home') {
      console.warn('不能删除首页分组');
      return;
    }
    // 删除分组时，将该分组的快捷方式移到首页
    const updatedShortcuts = shortcuts.map((s) =>
      s.groupId === id ? { ...s, groupId: 'home' } : s
    );
    const filtered = shortcutGroups.filter((g) => g.id !== id);
    set({
      shortcutGroups: filtered,
      shortcuts: updatedShortcuts,
      shortcutFolders: shortcutFolders.map(folder => folder.groupId === id ? { ...folder, groupId: 'home' } : folder),
      activeGroupId: activeGroupId === id ? 'home' : activeGroupId,
    });
    saveData();
  },

  getFilteredShortcuts: () => {
    const { shortcuts, activeGroupId } = get();
    // 如果没有选中分组，默认显示首页分组
    const targetGroupId = activeGroupId ?? 'home';
    // 只返回不在文件夹内的快捷方式
    return shortcuts.filter((s) => (s.groupId || 'home') === targetGroupId && !s.folderId).sort((a, b) => a.position - b.position);
  },

  // 文件夹操作
  addFolder: (name, groupId) => {
    const { shortcuts, shortcutFolders, activeGroupId, saveData } = get();
    const newFolder: ShortcutFolder = {
      id: generateId(),
      name,
      position: nextGroupPosition(shortcuts, shortcutFolders, groupId ?? activeGroupId ?? 'home'),
      groupId: groupId ?? activeGroupId ?? undefined,
      createdAt: Date.now(),
    };
    const newFolders = [...shortcutFolders, newFolder];
    set({ shortcutFolders: newFolders });
    saveData();
    return newFolder.id;
  },

  updateFolder: (id, updates) => {
    const { shortcutFolders, saveData } = get();
    const newFolders = shortcutFolders.map((f) => (f.id === id ? { ...f, ...updates } : f));
    set({ shortcutFolders: newFolders });
    saveData();
  },

  removeFolder: (id) => {
    const { shortcuts, shortcutFolders, saveData } = get();
    // 删除文件夹时，将文件夹内的快捷方式移出
    const folder = shortcutFolders.find((item) => item.id === id);
    let position = nextGroupPosition(shortcuts, shortcutFolders, folder?.groupId || 'home');
    const updatedShortcuts = shortcuts.map((s) =>
      s.folderId === id ? { ...s, folderId: undefined, groupId: folder?.groupId || 'home', position: position++ } : s
    );
    const filtered = shortcutFolders.filter((f) => f.id !== id);
    set({ shortcutFolders: filtered, shortcuts: updatedShortcuts });
    saveData();
  },

  getFolderShortcuts: (folderId) => {
    const { shortcuts } = get();
    return shortcuts.filter((s) => s.folderId === folderId).sort((a, b) => a.position - b.position);
  },

  moveShortcutToFolder: (shortcutId, folderId) => {
    const { shortcuts, shortcutFolders, updateShortcut } = get();
    const shortcut = shortcuts.find((item) => item.id === shortcutId);
    if (!shortcut || shortcut.folderId === folderId) return;
    const folder = folderId ? shortcutFolders.find((item) => item.id === folderId) : undefined;
    if (folderId && !folder) return;
    const position = folderId
      ? Math.max(-1, ...shortcuts.filter((item) => item.id !== shortcutId && item.folderId === folderId).map((item) => item.position)) + 1
      : nextGroupPosition(shortcuts, shortcutFolders, shortcut.groupId || 'home');
    updateShortcut(shortcutId, { folderId, groupId: folder ? folder.groupId || 'home' : shortcut.groupId, position });
  },

  // 网格项操作
  addGridItem: (type, options = {}) => {
    const { gridItems, activeGroupId, saveData } = get();
    const meta = getWidgetMeta(type);
    const defaultConfig = getDefaultWidgetConfig(type);

    const newItem: GridItem = {
      id: generateId(),
      type,
      size: options.size || meta.sizeConfig.defaultSize,
      position: gridItems.length,
      groupId: options.groupId ?? activeGroupId ?? undefined,
      shortcut: options.shortcut,
      config: type !== 'shortcut' ? defaultConfig : undefined,
      createdAt: Date.now(),
    };

    const newGridItems = [...gridItems, newItem];
    set({ gridItems: newGridItems });
    saveData();

    // 如果是快捷方式类型，异步下载并缓存 favicon
    if (type === 'shortcut' && options.shortcut?.url) {
      (async () => {
        try {
          const { downloadFavicon } = await import('../utils/favicon');
          const base64 = await downloadFavicon(options.shortcut!.url);
          if (base64) {
            const { updateGridItem } = get();
            updateGridItem(newItem.id, {
              shortcut: {
                ...options.shortcut!,
                faviconBase64: base64,
              },
            });
          }
        } catch (error) {
          console.error('Failed to cache favicon for grid item:', error);
        }
      })();
    }
  },

  updateGridItem: (id, updates) => {
    const { gridItems, saveData } = get();
    const newGridItems = gridItems.map((item) =>
      item.id === id ? { ...item, ...updates } : item
    );
    set({ gridItems: newGridItems });
    saveData();
  },

  removeGridItem: (id) => {
    const { gridItems, saveData } = get();
    const filtered = gridItems.filter((item) => item.id !== id);
    const reordered = filtered.map((item, index) => ({ ...item, position: index }));
    set({ gridItems: reordered });
    saveData();
  },

  reorderGridItems: (fromIndex, toIndex) => {
    const { gridItems, saveData } = get();
    const newGridItems = [...gridItems];
    const [removed] = newGridItems.splice(fromIndex, 1);
    newGridItems.splice(toIndex, 0, removed);
    const reordered = newGridItems.map((item, index) => ({ ...item, position: index }));
    set({ gridItems: reordered });
    saveData();
  },

  getFilteredGridItems: () => {
    const { gridItems, activeGroupId } = get();
    // 如果没有选中分组，默认显示首页分组
    const targetGroupId = activeGroupId ?? 'home';
    return gridItems.filter((item) => item.groupId === targetGroupId);
  },

  // 数据迁移：将旧的 shortcuts 迁移到 gridItems
  migrateToGridItems: () => {
    const { shortcuts, gridItems, saveData } = get();

    // 如果没有 shortcuts，不需要迁移
    if (shortcuts.length === 0) return;

    // 找出尚未迁移的快捷方式
    const existingShortcutIds = new Set(
      gridItems
        .filter(item => item.type === 'shortcut' && item.shortcut)
        .map(item => item.id)
    );

    const newShortcuts = shortcuts.filter(s => !existingShortcutIds.has(s.id));

    if (newShortcuts.length === 0) return;

    // 迁移新的快捷方式
    const migratedItems: GridItem[] = newShortcuts.map((shortcut, index) => ({
      id: shortcut.id,
      type: 'shortcut' as GridItemType,
      size: '1x1' as GridItemSize,
      position: gridItems.length + index,
      groupId: shortcut.groupId,
      shortcut: {
        url: shortcut.url,
        title: shortcut.title,
        favicon: shortcut.favicon,
      },
      createdAt: shortcut.createdAt,
    }));

    const newGridItems = [...gridItems, ...migratedItems];
    set({ gridItems: newGridItems });
    saveData();
    console.log('[NewTab] 已迁移', migratedItems.length, '个快捷方式到网格系统');
  },



  // 清空所有网格项
}));
