/**
 * 快捷方式文件夹组件 - 液态玻璃效果
 * 参考 iTabs 实现：3x3 网格预览 + 动态光泽
 */

import { useEffect, useRef } from 'react';
import { Folder } from 'lucide-react';
import { useDndContext } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ShortcutFolder, Shortcut } from '../types';
import { ShortcutIcon } from './ShortcutIcon';

interface ShortcutFolderItemProps {
  folder: ShortcutFolder;
  shortcuts: Shortcut[];
  onOpen: (folderId: string) => void;
  isMergeTarget?: boolean;
}

// 迷你图标组件
function MiniIcon({ shortcut }: { shortcut: Shortcut }) {
  return (
    <div className="aspect-square rounded-md overflow-hidden liquid-glass-mini flex items-center justify-center">
      <ShortcutIcon shortcut={shortcut} className="h-full w-full !rounded-md" />
    </div>
  );
}

export function ShortcutFolderItem({
  folder,
  shortcuts,
  onOpen,
  isMergeTarget = false,
}: ShortcutFolderItemProps) {
  const folderRef = useRef<HTMLDivElement>(null);
  const { active } = useDndContext();
  const isShortcutDrag = active?.data.current?.type === 'shortcut';
  
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: folder.id, data: { type: 'folder', groupId: folder.groupId || 'home' },
    disabled: { draggable: isShortcutDrag, droppable: false } });
  const isDropTarget = isShortcutDrag && isOver;

  const sortableStyle = {
    transform: isShortcutDrag ? undefined : CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 1,
  };

  // 动态光泽效果 - 跟随鼠标
  useEffect(() => {
    const element = folderRef.current;
    if (!element) return;

    const handleMouseMove = (e: MouseEvent) => {
      const rect = element.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      element.style.setProperty('--mouse-x', `${x}%`);
      element.style.setProperty('--mouse-y', `${y}%`);
    };

    element.addEventListener('mousemove', handleMouseMove);
    return () => element.removeEventListener('mousemove', handleMouseMove);
  }, []);

  // 获取前9个快捷方式用于预览
  const previewShortcuts = shortcuts.slice(0, 9);
  const iconSize = 64; // 图标大小
  const padding = iconSize * 0.12;

  return (
    <div
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      data-shortcut-id={folder.id}
      className={`relative flex min-h-[156px] w-full min-w-0 flex-col items-center gap-3 rounded-2xl px-2 py-3 cursor-grab active:cursor-grabbing transition-colors ${isDropTarget ? 'bg-blue-500/20 ring-2 ring-inset ring-blue-300' : 'hover:bg-white/10'}`}
      title={folder.name}
      onClick={() => !isDragging && onOpen(folder.id)}
    >
      {/* 液态玻璃文件夹图标 */}
      <div
        ref={folderRef}
        className={`
          relative liquid-glass-folder rounded-[18px] overflow-hidden
          hover:scale-110 transition-all duration-200
          ${isDragging ? 'shadow-xl ring-2 ring-white/30 scale-105' : ''}
        `}
        style={{
          width: `${iconSize}px`,
          height: `${iconSize}px`,
          padding: `${padding}px`,
        }}
      >
        {/* 玻璃折射效果 */}
        <div className="glass-refraction" />
        
        {/* 3x3 网格预览 */}
        {previewShortcuts.length > 0 ? (
          <div className="w-full h-full grid grid-cols-3 gap-0.5 content-start relative z-10">
            {previewShortcuts.map((shortcut) => (
              <MiniIcon key={shortcut.id} shortcut={shortcut} />
            ))}
            {/* 填充空位 */}
            {Array.from({ length: Math.max(0, 9 - previewShortcuts.length) }).map((_, i) => (
              <div
                key={`empty-${i}`}
                className="aspect-square rounded-md bg-white/5"
              />
            ))}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center relative z-10">
            <Folder className="w-6 h-6 text-white/60" />
          </div>
        )}

        {/* 合并目标高亮 */}
        {(isMergeTarget || isDropTarget) && <div className="merge-target-highlight" />}
      </div>

      {isDropTarget && <span className="pointer-events-none absolute bottom-1 rounded-lg bg-blue-500 px-2 py-1 text-xs text-white">松开移入文件夹</span>}
      {/* 文件夹名称 */}
      <span className="line-clamp-3 min-h-[60px] w-full break-words text-center text-sm font-medium leading-5 text-white/90 text-shadow-sm [overflow-wrap:anywhere]">
        {folder.name}
      </span>
    </div>
  );
}
