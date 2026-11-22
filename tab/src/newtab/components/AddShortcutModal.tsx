/**
 * 添加快捷方式弹窗组件
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Link, Type, StickyNote } from 'lucide-react';
import { Z_INDEX } from '../constants/z-index';
import type { Shortcut } from '../types';

interface AddShortcutModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (url: string, title: string, note: string) => void;
  shortcut?: Shortcut;
  groupName?: string;
}

export function AddShortcutModal({ isOpen, onClose, onAdd, groupName, shortcut }: AddShortcutModalProps) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (isOpen) {
      setUrl(shortcut?.url || '');
      setTitle(shortcut?.title || '');
      setNote(shortcut?.note || '');
      setError('');
    }
  }, [isOpen, shortcut?.id]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    setError('');
    if (!url.trim()) {
      setError('请输入网址');
      return;
    }
    try {
      const input = url.trim();
      const fullUrl = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
      const parsed = new URL(fullUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid protocol');
      const domain = parsed.hostname;
      const finalTitle = title.trim() || domain;
      onAdd(fullUrl, finalTitle, note.trim());
      setUrl('');
      setTitle('');
      setNote('');
      onClose();
    } catch {
      setError('无效的网址格式');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center animate-fadeIn" style={{ zIndex: Z_INDEX.MODAL_BACKDROP + 20 }}>
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      
      {/* 弹窗内容 */}
      <div className="relative w-[400px] max-w-[90vw]" style={{ zIndex: Z_INDEX.MODAL_CONTENT + 20, animation: 'modalScale 0.2s ease-out' }}>
        <div role="dialog" aria-modal="true" aria-label={shortcut ? "编辑快捷方式" : "添加快捷方式"} onKeyDown={handleKeyDown} className="glass-modal rounded-2xl p-6 max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-medium text-white">
              {shortcut ? '编辑快捷方式' : '添加快捷方式'}
              {!shortcut && groupName && <span className="ml-2 text-sm text-white/50">到 {groupName}</span>}
            </h3>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
              <X className="w-5 h-5 text-white/60" />
            </button>
          </div>
          <div className="space-y-4">
            <div>
              <label className="flex items-center gap-2 text-sm text-white/60 mb-2">
                <Link className="w-4 h-4" />
                网址
              </label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full bg-white/10 text-white text-sm rounded-xl px-4 py-3 outline-none border border-white/20 focus:border-blue-500/50 placeholder:text-white/30 transition-colors"
                autoFocus
              />
            </div>
            <div>
              <label className="flex items-center gap-2 text-sm text-white/60 mb-2">
                <Type className="w-4 h-4" />
                名称 <span className="text-white/30">(可选)</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="自动获取域名"
                className="w-full bg-white/10 text-white text-sm rounded-xl px-4 py-3 outline-none border border-white/20 focus:border-blue-500/50 placeholder:text-white/30 transition-colors"
              />
            </div>
            <div>
              <label htmlFor="shortcut-note" className="mb-2 flex items-center gap-2 text-sm text-white/60">
                <StickyNote className="h-4 w-4" />备注 <span className="text-white/30">(可选)</span>
              </label>
              <textarea id="shortcut-note" value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000}
                placeholder="写下用途、提示等，悬停快捷方式时显示"
                className="w-full resize-y rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-blue-500/50" />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
          </div>
          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-white/10 hover:bg-white/20 text-white/70 text-sm transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSubmit}
              className="flex-1 py-2.5 rounded-xl bg-blue-500/80 hover:bg-blue-500 text-white text-sm transition-colors"
            >
              {shortcut ? '保存修改' : '添加'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
