import { useEffect, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { SYNC_KEY, requestImmediateSync, resolveSyncConflict, switchSyncAccount, operationKey, type SyncJournal } from '../services/sync-engine';
import { newJournal } from '../services/sync-journal';
import type { SyncValue } from '../services/sync-journal';
function describe(value: SyncValue | null | undefined, name: (collection: 'groups' | 'folders', id: string | number) => string) {
  if (!value) return '删除此记录';
  return [value.title || value.name, value.url, value.note && `备注：${value.note}`, value.groupId && `分组：${name('groups', value.groupId)}`, value.folderId && `文件夹：${name('folders', value.folderId)}`, `顺序：${value.position}`, value.fallbackIcon && `图标：${value.fallbackIcon}`, value.favicon && `图标：${value.favicon}`, value.faviconBase64 && '含缓存图标'].filter(Boolean).join('\n');
}
export function SyncStatus({ compact = false, onOpenSettings }: { compact?: boolean; onOpenSettings?: () => void }) {
  const [state, setState] = useState<SyncJournal>(newJournal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    chrome.storage.local.get(SYNC_KEY).then(data => { if (active) setState((data[SYNC_KEY] as SyncJournal) || newJournal()); });
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[SYNC_KEY]) setState((changes[SYNC_KEY].newValue as SyncJournal) || newJournal());
    };
    chrome.storage.onChanged.addListener(listener);
    return () => { active = false; chrome.storage.onChanged.removeListener(listener); };
  }, []);
  const name = (collection: 'groups' | 'folders', id: string | number) => String(state.pending[operationKey(collection, String(id))]?.value?.name || state.remote.entities[collection][String(id)]?.value.name || (id === 'home' ? '首页' : '已删除'));
  const count = Object.keys(state.pending).length;
  const label = state.phase === 'syncing' ? '正在同步…' : state.phase === 'unconfigured' ? '未配置同步'
    : state.phase === 'account-changed' ? '同步已暂停：账户配置变更' : state.conflicts.length ? `${state.conflicts.length} 项冲突待处理`
    : state.phase === 'error' ? '同步失败，将自动重试' : count ? `${count} 项修改待上传` : state.lastSyncedAt ? '已同步到云端' : '等待同步';
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  };
  return <div className={compact ? 'rounded-xl bg-white/5 p-2 text-[11px] text-white/70' : 'space-y-3 text-sm text-white/80'}>
    <p role="status" className="break-words" title={state.message}>{label}</p>
    {!compact && state.lastSyncedAt && <p className="text-xs text-white/50">上次成功：{new Date(state.lastSyncedAt).toLocaleString()}</p>}
    <button type="button" disabled={busy || state.phase === 'syncing' || state.phase === 'account-changed'}
      className="mt-2 flex w-full items-center justify-center gap-1 rounded-lg bg-white/10 px-2 py-2 hover:bg-white/20 disabled:opacity-40"
      onClick={() => void action(requestImmediateSync)}><CloudUpload className="h-4 w-4 shrink-0" />{busy ? '处理中…' : '立即上传'}</button>
    {compact && (state.conflicts.length > 0 || state.phase === 'error' || state.phase === 'account-changed' || state.phase === 'unconfigured') && <button className="mt-2 text-blue-300 underline" onClick={onOpenSettings}>查看同步设置</button>}
    {!compact && <>
      <p className="text-xs leading-relaxed text-white/50">修改后约 2 秒自动上传，关闭页面后仍会重试；每分钟检查云端更新。仅同步明确的修改和删除，保留未修改的云端数据。</p>
      {state.message && <p className="break-words text-amber-200">{state.message}</p>}
      {state.phase === 'account-changed' && <button disabled={busy} className="rounded-lg bg-amber-500/20 p-3 text-amber-200" onClick={() => {
        if (confirm('先备份当前账户的本地数据和待上传修改，再读取新账户的云端数据。备份保留在本机扩展存储中。是否切换？')) void action(async () => { await switchSyncAccount(); await requestImmediateSync(); });
      }}>备份本地并切换同步账户</button>}
      {state.conflicts.map(conflict => <div key={operationKey(conflict.collection, conflict.id)} className="space-y-2 rounded-lg border border-amber-300/20 p-3">
        <p className="font-medium text-amber-200">同一记录在两处发生修改，请选择保留的版本</p>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><p className="mb-1 text-white/50">本地版本</p><p className="whitespace-pre-wrap break-all">{describe(conflict.local.value, name)}</p></div>
          <div><p className="mb-1 text-white/50">云端版本</p><p className="whitespace-pre-wrap break-all">{describe(conflict.remote?.deleted ? null : conflict.remote?.value, name)}</p></div>
        </div>
        <div className="flex gap-2">{(['local', 'cloud'] as const).map(choice => <button disabled={busy} key={choice} className="rounded bg-white/10 px-3 py-2 hover:bg-white/20" onClick={() => void action(async () => {
          await resolveSyncConflict(operationKey(conflict.collection, conflict.id), choice); await requestImmediateSync();
        })}>{choice === 'local' ? '保留本地并上传' : '采用云端'}</button>)}</div>
      </div>)}
    </>}
    {error && <p role="alert" className="mt-2 break-words text-amber-200">{error}</p>}
  </div>;
}
