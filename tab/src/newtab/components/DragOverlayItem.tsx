/**
 * 拖拽覆盖层项目组件 - 显示拖拽时的预览
 */

import { Folder } from 'lucide-react';
import { ShortcutIcon } from './ShortcutIcon';
import type { Shortcut, ShortcutFolder } from '../types';

interface DragOverlayItemProps {
  item: (Shortcut | ShortcutFolder) & { itemType: 'shortcut' | 'folder' };
  shortcuts?: Shortcut[];
}

export function DragOverlayItem({ item, shortcuts = [] }: DragOverlayItemProps) {
  if (item.itemType === 'folder') {
    const folder = item as ShortcutFolder;
    const previewShortcuts = shortcuts.slice(0, 9);
    const iconSize = 64;
    const padding = iconSize * 0.12;

    return (
      <div className="flex min-h-[156px] flex-col items-center gap-3 px-2 py-3 opacity-90 cursor-grabbing">
        <div
          className="relative liquid-glass-folder rounded-[18px] overflow-hidden shadow-2xl scale-110"
          style={{
            width: `${iconSize}px`,
            height: `${iconSize}px`,
            padding: `${padding}px`,
          }}
        >
          <div className="glass-refraction" />
          {previewShortcuts.length > 0 ? (
            <div className="w-full h-full grid grid-cols-3 gap-0.5 content-start relative z-10">
              {previewShortcuts.map((shortcut) => {
                return (
                  <ShortcutIcon key={shortcut.id} shortcut={shortcut} className="aspect-square h-full w-full !rounded-md" />
                );
              })}
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center relative z-10">
              <Folder className="w-6 h-6 text-white/60" />
            </div>
          )}
        </div>
        <span className="line-clamp-3 min-h-[60px] w-full break-words text-center text-sm font-medium leading-5 text-white/90 drop-shadow-md [overflow-wrap:anywhere]">
          {folder.name}
        </span>
      </div>
    );
  }

  // 快捷方式
  const shortcut = item as Shortcut;

  return (
    <div className="flex min-h-[156px] flex-col items-center gap-3 px-2 py-3 opacity-90 cursor-grabbing">
      <div className="relative w-16 h-16 shrink-0 rounded-[20px] liquid-glass-icon flex items-center justify-center overflow-hidden shadow-2xl scale-110">
        <div className="glass-refraction" />
        <ShortcutIcon shortcut={shortcut} className="relative z-10 h-[82%] w-[82%]" />
      </div>
      <span className="line-clamp-3 min-h-[60px] w-full break-words text-center text-sm font-medium leading-5 text-white/90 drop-shadow-md [overflow-wrap:anywhere]">
        {shortcut.title}
      </span>
    </div>
  );
}
