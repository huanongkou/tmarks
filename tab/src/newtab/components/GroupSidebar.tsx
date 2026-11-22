/**
 * 左侧分组侧边栏：全高布局，直接显示分组名称
 */

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { useDndContext } from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getGroupLayout } from '../utils/group-layout';
import { createPortal } from 'react-dom';
import {
  Plus,
  X,
  Folder,
  Home,
  Briefcase,
  GraduationCap,
  Gamepad2,
  Wrench,
  Code,
  Music,
  Film,
  ShoppingCart,
  Heart,
  Star,
  Bookmark,
  Globe,
  Zap,
  BookMarked,
  Settings,
  Pin,
  PinOff,
  ChevronRight,
} from 'lucide-react';
import { useNewtabStore } from '../hooks/useNewtabStore';
import { GROUP_ICONS } from '../constants';
import { SyncStatus } from './SyncStatus';
import { StorageService } from '@/lib/utils/storage';
import { getTMarksUrls } from '@/lib/constants/urls';

// 图标映射
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Home,
  Briefcase,
  GraduationCap,
  Gamepad2,
  Wrench,
  Code,
  Music,
  Film,
  ShoppingCart,
  Heart,
  Star,
  Bookmark,
  Folder,
  Globe,
  Zap,
};

function getIconComponent(iconName: string) {
  return ICON_MAP[iconName] || Folder;
}

function GroupDropTarget({ groupId, disabled, className, children }: {
  groupId: string; disabled: boolean; className: string; children: ReactNode;
}) {
  const { active } = useDndContext();
  const isShortcutDrag = active?.data.current?.type === 'shortcut';
  const { setNodeRef, isOver, isDragging, transform, transition, attributes, listeners } = useSortable({
    id: `group:${groupId}`, disabled: { draggable: disabled, droppable: disabled || (isShortcutDrag && !useNewtabStore.getState().settings.sidebarPinned) },
    data: { type: 'group', groupId },
  });
  const isTarget = !disabled && isOver && isShortcutDrag;
  return (
    <div ref={setNodeRef} {...attributes} {...listeners}
      style={{ transform: active?.data.current?.type === 'group' ? CSS.Transform.toString(transform) : undefined, transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 30 : undefined }}
      className={`${className} relative min-h-0 min-w-0 cursor-grab active:cursor-grabbing ${isTarget ? 'bg-blue-500/30 ring-2 ring-inset ring-blue-300' : ''}`}>
      {children}
      {isTarget && <span className="pointer-events-none absolute bottom-0 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-blue-500 px-1 text-[9px] text-white">松开移入</span>}
    </div>
  );
}

interface GroupSidebarProps {
  onOpenSettings?: () => void;
  onOpenSync?: () => void;
}

export function GroupSidebar({ onOpenSettings, onOpenSync }: GroupSidebarProps) {
  const { shortcutGroups, shortcuts, settings, updateSettings, activeGroupId, setActiveGroup, addGroup, updateGroup, removeGroup } =
    useNewtabStore();
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const isPinned = settings.sidebarPinned;
  const { active: activeDrag } = useDndContext();
  const isSortingGroups = activeDrag?.data.current?.type === 'group';
  const isVisible = isPinned || isHovered || showAddMenu || editingGroupId !== null || isSortingGroups;
  const groupListRef = useRef<HTMLElement>(null);
  const [groupArea, setGroupArea] = useState({ height: 400, width: 184 });
  const groupLayout = getGroupLayout(shortcutGroups.length, groupArea.height, groupArea.width);
  useEffect(() => {
    const list = groupListRef.current;
    if (!list) return;
    const measure = () => setGroupArea({ height: list.clientHeight, width: list.clientWidth });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedIcon, setSelectedIcon] = useState('Folder');
  const [tmarksUrl, setTmarksUrl] = useState('');
  useEffect(() => {
    if (!showAddMenu) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowAddMenu(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [showAddMenu]);

  useEffect(() => {
    if (editingGroupId) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [editingGroupId]);

  const startRename = (groupId: string) => {
    editingIdRef.current = groupId;
    setEditingGroupId(groupId);
  };

  const finishRename = (save: boolean) => {
    const groupId = editingIdRef.current;
    if (!groupId) return;
    // 清空引用后再关闭输入框，避免 Esc / Enter 引发的 blur 重复保存。
    editingIdRef.current = null;
    const name = nameInputRef.current?.value.trim() || '';
    const current = shortcutGroups.find((group) => group.id === groupId);
    if (save && name && current && name !== current.name) updateGroup(groupId, { name });
    setEditingGroupId(null);
  };

  // 加载用户配置的 TMarks URL
  useEffect(() => {
    const loadTMarksUrl = async () => {
      const config = await StorageService.getTMarksConfig();
      if (config?.bookmarkApiUrl) {
        const baseUrl = config.bookmarkApiUrl.replace(/\/api\/?$/, '');
        setTmarksUrl(baseUrl);
      } else {
        setTmarksUrl(getTMarksUrls().BASE_URL);
      }
    };
    loadTMarksUrl();
  }, []);

  const handleAddGroup = () => {
    if (newGroupName.trim()) {
      addGroup(newGroupName.trim(), selectedIcon);
      setNewGroupName('');
      setSelectedIcon('Folder');
      setShowAddMenu(false);
    }
  };

  const handleRemoveGroup = (e: React.MouseEvent, groupId: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (confirm('删除分组后，该分组的快捷方式将移到"首页"。确定删除？')) {
      removeGroup(groupId);
    }
  };

  return (
    <>
      {!isVisible && (
        <button
          type="button"
          aria-label="展开分组侧栏"
          title="展开分组侧栏"
          className="fixed left-0 top-1/2 z-30 flex h-24 w-3.5 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-white/20 bg-slate-900/70 text-white/70 hover:bg-slate-800"
          onMouseEnter={() => setIsHovered(true)}
          onFocus={() => setIsHovered(true)}
          onClick={() => setIsHovered(true)}
        >
          <ChevronRight className="h-4 w-4 shrink-0" />
        </button>
      )}
      <aside
        aria-label="分组导航"
        className="fixed inset-y-0 left-0 z-20 flex w-[var(--newtab-sidebar-width)] flex-col border-r border-white/10 bg-slate-950/75 backdrop-blur-2xl transition-transform duration-200 motion-reduce:transition-none"
        style={{ transform: isVisible ? 'translateX(0)' : 'translateX(calc(-100% + 14px))' }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onFocusCapture={() => setIsHovered(true)}
        onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsHovered(false); }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onWheel={(event) => event.stopPropagation()}
      >
        <div className="flex h-24 shrink-0 flex-col items-center justify-center gap-2 px-2 sm:flex-row sm:gap-3 sm:justify-start sm:px-4">
          <div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-white sm:flex">
            <Folder className="h-6 w-6" />
          </div>
          <div className="hidden min-w-0 flex-1 sm:block">
            <h2 className="text-base font-semibold text-white">分组</h2>
            <p className="mt-1 text-xs text-white/45">{shortcutGroups.length} 个分组</p>
          </div>
          <span className="text-xs text-white/70 sm:hidden">分组</span>
          <button
            type="button"
            aria-label={isPinned ? '取消固定侧栏' : '固定侧栏'}
            aria-pressed={isPinned}
            title={isPinned ? '取消固定，鼠标离开后收起' : '固定侧栏，可拖动快捷方式到分组'}
            onClick={() => { setIsHovered(true); updateSettings({ sidebarPinned: !isPinned }); }}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 ${isPinned ? 'bg-blue-500/25 text-blue-300' : 'bg-white/5 text-white/60 hover:bg-white/15 hover:text-white'}`}
          >
            {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        </div>

        <div className="shrink-0 px-2 pb-4 sm:px-3">
          <button
            onClick={() => setShowAddMenu(true)}
            className="flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/20 px-2 py-2 text-xs text-white/70 transition-colors hover:border-white/40 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:flex-row sm:gap-2 sm:text-sm"
            title="新建分组"
          >
            <Plus className="h-5 w-5 shrink-0" />
            <span>新建分组</span>
          </button>
          <p className="mt-2 hidden text-center text-[11px] text-white/45 sm:block">
            {isPinned ? '拖动分组排序 · 拖入网址归类' : '拖动分组排序 · 离开自动收起'}
          </p>
        </div>

        <div className="min-h-0 flex-1 px-2 pb-3 sm:px-3">
        <nav ref={groupListRef} className="grid h-full min-h-0 content-start overflow-hidden" aria-label="分组列表"
          style={{ gridTemplateColumns: `repeat(${groupLayout.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${groupLayout.rows}, ${groupLayout.rowHeight}px)`, gap: groupLayout.gap }}>
          <SortableContext items={shortcutGroups.map((group) => `group:${group.id}`)} strategy={rectSortingStrategy}>
          {shortcutGroups.map((group) => {
            const IconComponent = getIconComponent(group.icon);
            const isActive = (activeGroupId || 'home') === group.id;
            const count = shortcuts.filter((shortcut) => (shortcut.groupId || 'home') === group.id).length;
            return (
              <GroupDropTarget
                key={group.id}
                groupId={group.id}
                disabled={editingGroupId !== null}
                className={`group flex items-center rounded-xl border transition-colors ${
                  isActive ? 'border-white/15 bg-white/15 text-white shadow-sm' : 'border-transparent text-white/60 hover:bg-white/10 hover:text-white'
                }`}
              >
                {editingGroupId === group.id ? (
                  <div className="flex h-full min-h-0 min-w-0 flex-1 items-center gap-1 px-1">
                    <IconComponent className="hidden h-5 w-5 shrink-0 sm:block" />
                    <input
                      ref={nameInputRef}
                      aria-label="分组名称"
                      defaultValue={group.name}
                      maxLength={50}
                      className="w-full min-w-0 rounded-md border border-blue-400/60 bg-white/10 px-1 py-1 text-xs text-white outline-none focus:ring-1 focus:ring-blue-300 sm:px-2 sm:text-sm"
                      onPointerDown={(event) => event.stopPropagation()}
                      onBlur={() => finishRename(true)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'Enter') { event.preventDefault(); finishRename(true); }
                        if (event.key === 'Escape') { event.preventDefault(); finishRename(false); }
                      }}
                      onContextMenu={(event) => event.stopPropagation()}
                    />
                  </div>
                ) : <button
                  onClick={() => setActiveGroup(group.id)}
                  onDoubleClick={(event) => { event.preventDefault(); startRename(group.id); }}
                  onKeyDown={(event) => { if (event.key === 'F2') { event.preventDefault(); startRename(group.id); } }}
                  onContextMenu={(event) => {
                    if (group.id !== 'home') handleRemoveGroup(event, group.id);
                  }}
                  aria-current={isActive ? 'page' : undefined}
                  title={`${group.name}（拖动排序，双击重命名）`}
                  className={`flex h-full min-h-0 min-w-0 flex-1 items-center justify-center rounded-xl px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/50 ${groupLayout.compact ? 'flex-col gap-0.5 py-0.5' : 'gap-3 sm:justify-start sm:px-3'}`}
                >
                  {groupLayout.rowHeight >= 38 && <IconComponent className="h-4 w-4 shrink-0" />}
                  <span className={`w-full min-w-0 truncate text-center font-medium ${groupLayout.compact ? 'text-[10px] leading-tight' : 'text-xs sm:flex-1 sm:text-left sm:text-sm'}`}>{group.name}</span>
                  {!groupLayout.compact && <span className="hidden shrink-0 text-xs tabular-nums text-white/40 sm:block">{count}</span>}
                </button>}
                {group.id !== 'home' && !groupLayout.compact && (
                  <button
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => handleRemoveGroup(event, group.id)}
                    className="mr-1 hidden h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white/40 opacity-0 transition-opacity hover:bg-white/10 hover:text-red-300 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 group-hover:opacity-100 group-focus-within:opacity-100 sm:flex"
                    title={`删除分组 ${group.name}`}
                    aria-label={`删除分组 ${group.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </GroupDropTarget>
            );
          })}
          </SortableContext>
        </nav>
        </div>

        <div className="shrink-0 space-y-1 border-t border-white/10 px-2 py-3 sm:px-3">
          <SyncStatus compact onOpenSettings={onOpenSync} />
          {tmarksUrl && (
            <a
              href={tmarksUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:flex-row sm:justify-start sm:gap-3 sm:px-3 sm:text-sm"
              title="书签管理"
            >
              <BookMarked className="h-5 w-5 shrink-0" />
              <span>书签管理</span>
            </a>
          )}
          <button
            onClick={onOpenSettings}
            className="flex min-h-12 w-full flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 sm:flex-row sm:justify-start sm:gap-3 sm:px-3 sm:text-sm"
            title="设置"
          >
            <Settings className="h-5 w-5 shrink-0" />
            <span>设置</span>
          </button>
        </div>
      </aside>

      {showAddMenu && createPortal(
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setShowAddMenu(false)}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="newtab-add-group-title"
            className="w-full max-w-sm rounded-2xl border border-white/15 bg-slate-900 p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => { event.preventDefault(); handleAddGroup(); }}
          >
            <div className="mb-5 flex items-center justify-between">
              <h3 id="newtab-add-group-title" className="text-base font-semibold text-white">新建分组</h3>
              <button type="button" onClick={() => setShowAddMenu(false)} aria-label="关闭" className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <label htmlFor="newtab-group-name" className="mb-2 block text-sm text-white/70">分组名称</label>
            <input
              id="newtab-group-name"
              type="text"
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              placeholder="输入分组名称"
              className="mb-5 w-full rounded-xl border border-white/20 bg-white/5 px-3 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-blue-400/70"
              autoFocus
            />
            <div className="mb-5 grid grid-cols-5 gap-2" role="group" aria-label="分组图标">
              {GROUP_ICONS.map((iconName) => {
                const Icon = getIconComponent(iconName);
                return (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => setSelectedIcon(iconName)}
                    aria-label={iconName}
                    aria-pressed={selectedIcon === iconName}
                    className={`flex h-11 items-center justify-center rounded-xl transition-colors ${selectedIcon === iconName ? 'bg-blue-500/25 text-blue-300 ring-1 ring-blue-400/60' : 'text-white/50 hover:bg-white/10 hover:text-white'}`}
                  >
                    <Icon className="h-5 w-5" />
                  </button>
                );
              })}
            </div>
            <button type="submit" disabled={!newGroupName.trim()} className="w-full rounded-xl bg-blue-500 py-3 text-sm font-medium text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40">
              创建分组
            </button>
          </form>
        </div>,
        document.body
      )}
    </>
  );
}
