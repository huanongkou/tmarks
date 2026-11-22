import { runNewtabSync, SYNC_KEY, type SyncJournal } from '../newtab/services/sync-engine';
const ALARM = 'tmarks-newtab-sync-v2';
export function initializeNewtabSync() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  const run = () => {
    if (!running) running = runNewtabSync().catch(() => {}).finally(() => { running = undefined; });
    return running;
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, 2000);
  };
  // A durable alarm survives closed pages and service-worker suspension.
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void run(); });
  chrome.runtime.onStartup.addListener(() => { void run(); });
  chrome.runtime.onInstalled.addListener(() => { void run(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SYNC_KEY] && JSON.stringify((changes[SYNC_KEY].oldValue as SyncJournal | undefined)?.pending) !== JSON.stringify((changes[SYNC_KEY].newValue as SyncJournal | undefined)?.pending)) schedule();
    if (changes.config) schedule();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== 'NEWTAB_SYNC_NOW') return;
    if (timer) clearTimeout(timer);
    run().then(() => respond({ success: true }), () => respond({ success: false }));
    return true;
  });
  void run();
}
