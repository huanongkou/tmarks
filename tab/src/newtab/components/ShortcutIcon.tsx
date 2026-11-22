import { useEffect, useState } from 'react';
import {
  Globe2, Bookmark, BookOpen, Briefcase, Code2, Compass, Coffee, Heart,
  Lightbulb, Music, Palette, Rocket, Star, Flame, Camera, Gem,
} from 'lucide-react';
import { getFaviconUrl } from '../utils/favicon';
import { pickLibraryIcon } from '../utils/icon-library';
import { useNewtabStore } from '../hooks/useNewtabStore';

const ICONS = { Globe2, Bookmark, BookOpen, Briefcase, Code2, Compass, Coffee, Heart,
  Lightbulb, Music, Palette, Rocket, Star, Flame, Camera, Gem };
const COLORS = {
  blue: 'from-blue-500 to-indigo-600', violet: 'from-violet-500 to-purple-700',
  emerald: 'from-emerald-400 to-teal-700', amber: 'from-amber-400 to-orange-600',
  rose: 'from-rose-400 to-pink-700', cyan: 'from-cyan-400 to-blue-600',
};

interface IconSource {
  id?: string;
  url: string;
  favicon?: string;
  faviconBase64?: string;
  fallbackIcon?: string;
  fallbackColor?: string;
}
interface ShortcutIconProps { shortcut: IconSource; className?: string }

function IconImage({ src, shortcut, className = '' }: ShortcutIconProps & { src: string }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [localFallback, setLocalFallback] = useState<ReturnType<typeof pickLibraryIcon> | null>(null);
  const fallback = shortcut.fallbackIcon ? shortcut : localFallback;
  const Icon = ICONS[fallback?.fallbackIcon as keyof typeof ICONS] || Globe2;
  const color = COLORS[fallback?.fallbackColor as keyof typeof COLORS] || COLORS.blue;

  useEffect(() => {
    if (shortcut.fallbackIcon || (src && status !== 'failed')) return;
    const chosen = pickLibraryIcon();
    setLocalFallback(chosen);
    const state = useNewtabStore.getState();
    const current = state.shortcuts.find((item) => item.id === shortcut.id);
    // 图片加载期间可能已刷新图标、修改网址或删除，避免写回过期结果。
    if (current && !current.fallbackIcon && current.url === shortcut.url && getFaviconUrl(current) === src) {
      state.updateShortcut(current.id, chosen);
    }
  }, [src, status, shortcut.id, shortcut.url, shortcut.fallbackIcon]);

  useEffect(() => {
    if (status !== 'loading' || !src || shortcut.fallbackIcon) return;
    const timer = setTimeout(() => setStatus('failed'), 15000);
    return () => clearTimeout(timer);
  }, [status, src, shortcut.fallbackIcon]);

  return (
    <span className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${className}`}>
      {(shortcut.fallbackIcon || status !== 'ready') && (
        <span className={`absolute inset-0 flex items-center justify-center rounded-[inherit] bg-gradient-to-br ${color} text-white`}
          role="img" aria-label={fallback ? '内置图标库图标' : '默认网站图标'}>
          <Icon className="h-[55%] w-[55%]" strokeWidth={1.6} />
        </span>
      )}
      {!shortcut.fallbackIcon && src && status !== 'failed' && (
        <img src={src} alt="" draggable={false}
          className={`relative h-full w-full object-contain ${status === 'ready' ? 'opacity-100' : 'opacity-0'}`}
          onError={() => setStatus('failed')}
          onLoad={(event) => {
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 || image.naturalHeight <= 1) { setStatus('failed'); return; }
            try {
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 16;
              const context = canvas.getContext('2d');
              if (context) {
                context.drawImage(image, 0, 0, 16, 16);
                if (!context.getImageData(0, 0, 16, 16).data.some((value, index) => index % 4 === 3 && value > 16)) {
                  setStatus('failed'); return;
                }
              }
            } catch { /* 跨域图片使用浏览器的加载结果。 */ }
            setStatus('ready');
          }} />
      )}
    </span>
  );
}

export function ShortcutIcon({ shortcut, className }: ShortcutIconProps) {
  const src = getFaviconUrl(shortcut);
  return <IconImage key={src} src={src} shortcut={shortcut} className={className} />;
}
