/**
 * 可排序的快捷方式项组件 - 液态玻璃效果
 */

import { useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNewtabStore } from '../hooks/useNewtabStore';
import { ShortcutIcon } from './ShortcutIcon';
import type { Shortcut } from '../types';

interface SortableShortcutItemProps {
  shortcut: Shortcut;
  style?: 'icon' | 'card';
  onContextMenu?: (e: React.MouseEvent, shortcut: Shortcut) => void;
  isMergeTarget?: boolean;
}

export function SortableShortcutItem({ 
  shortcut, 
  onContextMenu,
  isMergeTarget = false,
}: SortableShortcutItemProps) {
  const { incrementClickCount } = useNewtabStore();
  const iconRef = useRef<HTMLDivElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: shortcut.id, data: { type: 'shortcut' } });

  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1, // 拖拽时完全隐藏，由 DragOverlay 显示
    zIndex: isDragging ? 10 : 1,
  };

  // 动态光泽效果 - 跟随鼠标
  useEffect(() => {
    const element = iconRef.current;
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

  const handleClick = () => {
    if (!isDragging) {
      incrementClickCount(shortcut.id);
      window.location.href = shortcut.url;
    }
  };


  return (
    <div
      ref={setNodeRef}
      style={sortableStyle}
      {...attributes}
      {...listeners}
      title={[shortcut.title, shortcut.note].filter(Boolean).join('\n\n')}
      data-shortcut-id={shortcut.id}
      className={`
        relative flex min-h-[156px] w-full min-w-0 flex-col items-center gap-3 rounded-2xl px-2 py-3 cursor-grab active:cursor-grabbing group
        transition-colors duration-200 hover:bg-white/10 hover:z-10
      `}
      onClick={handleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onContextMenu) {
          onContextMenu(e, shortcut);
        }
      }}
    >
      {/* 液态玻璃图标 */}
      <div
        ref={iconRef}
        className={`
          relative w-16 h-16 shrink-0 rounded-[20px] liquid-glass-icon flex items-center justify-center overflow-hidden
          transition-all duration-200
          ${isDragging ? 'shadow-xl ring-2 ring-white/30 scale-105' : ''}
        `}
      >
        {/* 玻璃折射效果 */}
        <div className="glass-refraction" />
        
        {/* 图标 */}
        <ShortcutIcon shortcut={shortcut} className="relative z-10 h-[82%] w-[82%]" />

        {/* 合并目标高亮 */}
        {isMergeTarget && <div className="merge-target-highlight" />}
      </div>

      {/* 标题 */}
      <span className="line-clamp-3 min-h-[60px] w-full break-words text-center text-sm font-medium leading-5 text-white/90 drop-shadow-md select-none [overflow-wrap:anywhere]">
        {shortcut.title}
      </span>
    </div>
  );
}
