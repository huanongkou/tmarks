import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';
import { DragOverlayItem } from './DragOverlayItem';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useNewtabStore } from '../hooks/useNewtabStore';
import { newtabCollisionDetection } from '../utils/drag-collision';

export function NewtabDragContext({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const { shortcuts, shortcutFolders, shortcutGroups } = useNewtabStore();
  const activeGroup = shortcutGroups.find((group) => `group:${group.id}` === activeId);
  const shortcut = shortcuts.find((item) => item.id === activeId);
  const folder = shortcutFolders.find((item) => item.id === activeId);
  const activeItem = shortcut ? { ...shortcut, itemType: 'shortcut' as const } : folder ? { ...folder, itemType: 'folder' as const } : null;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    useNewtabStore.setState({ draggingShortcutId: null });
    const state = useNewtabStore.getState();
    if (active.data.current?.type === 'group') {
      if (over?.data.current?.type === 'group') state.reorderGroups(active.data.current.groupId, over.data.current.groupId);
      return;
    }
    if (active.data.current?.type === 'shortcut' && over?.data.current?.type === 'folder') {
      const shortcut = state.shortcuts.find((item) => item.id === active.id);
      const folder = state.shortcutFolders.find((item) => item.id === over.id);
      if (shortcut && folder && shortcut.folderId !== folder.id) {
        state.moveShortcutToFolder(shortcut.id, folder.id);
        setNotice(`已将「${shortcut.title}」移入「${folder.name}」`);
      }
      return;
    }
    if (!state.settings.sidebarPinned || active.data.current?.type !== 'shortcut' || over?.data.current?.type !== 'group') return;
    const group = state.shortcutGroups.find((item) => item.id === over.data.current?.groupId);
    const shortcut = state.shortcuts.find((item) => item.id === active.id);
    if (!group || !shortcut || ((shortcut.groupId || 'home') === group.id && !shortcut.folderId)) return;
    state.moveShortcutToGroup(shortcut.id, group.id);
    setNotice(`已将「${shortcut.title}」移到「${group.name}」`);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={newtabCollisionDetection}
      onDragStart={({ active }) => { setActiveId(String(active.id)); useNewtabStore.setState({ draggingShortcutId: active.data.current?.type === 'shortcut' ? String(active.id) : null }); }}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { setActiveId(null); useNewtabStore.setState({ draggingShortcutId: null }); }}
    >
      {children}
      {createPortal(
        <DragOverlay zIndex={500}>
          {activeGroup ? (
            <div className="flex h-full min-h-6 w-full items-center gap-1 rounded-xl border border-blue-300/50 bg-slate-900/95 px-2 text-xs text-white shadow-xl">
              <GripVertical className="h-4 w-4 shrink-0 text-blue-300" />
              <span className="min-w-0 truncate">{activeGroup.name}</span>
            </div>
          ) : activeItem && <DragOverlayItem item={activeItem} shortcuts={activeItem.itemType === 'folder' ? shortcuts.filter((item) => item.folderId === activeItem.id) : []} />}
        </DragOverlay>,
        document.body,
      )}
      <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-24 left-1/2 z-[150] -translate-x-1/2">
        {notice && <div className="rounded-xl border border-white/15 bg-slate-900/95 px-5 py-3 text-sm text-white shadow-xl">{notice}</div>}
      </div>
    </DndContext>
  );
}
