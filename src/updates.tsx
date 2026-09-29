import { useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { ChevronDown, Download, RefreshCw, X } from 'lucide-react';

type UpdateStatus = 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'restarting' | 'error';
const checkInterval = 6 * 60 * 60 * 1000;
const isDev = import.meta.env.DEV;
const errorText = (reason: unknown) => typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'Trackline could not reach the update server.';

export function useAppUpdates() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const isBusy = useRef(false);

  const checkForUpdates = async () => {
    if (isDev || isBusy.current) return;
    isBusy.current = true;
    setError('');
    setStatus(current => current === 'available' ? current : 'checking');
    try {
      const result = await check();
      setLastChecked(new Date());
      if (result) { setUpdate(result); setStatus('available'); setIsDismissed(false); }
      else { setUpdate(null); setStatus('none'); }
    } catch (reason) {
      setError(errorText(reason)); setStatus('error');
    } finally { isBusy.current = false; }
  };

  const installUpdate = async () => {
    if (!update) return;
    setError(''); setStatus('downloading'); setProgress(0);
    let total = 0; let received = 0;
    try {
      await update.downloadAndInstall(event => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        else if (event.event === 'Progress') { received += event.data.chunkLength; if (total) setProgress(Math.min(1, received / total)); }
      });
      setStatus('restarting');
      await relaunch();
    } catch (reason) {
      setError(errorText(reason)); setStatus('error');
    }
  };

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => undefined);
    if (isDev) return;
    const first = window.setTimeout(checkForUpdates, 5000);
    const timer = window.setInterval(checkForUpdates, checkInterval);
    return () => { window.clearTimeout(first); window.clearInterval(timer); };
  }, []);

  return { currentVersion, status, update, progress, error, lastChecked, isDismissed, isDev, dismiss: () => setIsDismissed(true), checkForUpdates, installUpdate };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;

function ReleaseNotes({ body }: { body: string }) {
  const blocks = body.split('\n').map(line => line.trim()).filter(Boolean).map(line => line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1'));
  return <div className="update-notes">{blocks.map((line, index) => line.startsWith('#')
    ? <strong key={index}>{line.replace(/^#+\s*/, '')}</strong>
    : <p key={index}>{line.replace(/^[-*]\s*/, '')}</p>)}</div>;
}

export function UpdateBanner({ updates }: { updates: AppUpdates }) {
  const [showNotes, setShowNotes] = useState(false);
  const { update, status, progress, error, isDismissed } = updates;
  if (!update || isDismissed) return null;
  const isWorking = status === 'downloading' || status === 'restarting';
  const message = status === 'downloading' ? `Downloading… ${Math.round(progress * 100)}%`
    : status === 'restarting' ? 'Restarting Trackline…'
    : status === 'error' ? error
    : `You have ${updates.currentVersion || 'an older version'}.`;
  return <div className="update-banner" role="status" aria-live="polite">
    <div className="update-row">
      <Download size={15} aria-hidden="true" />
      <p><strong>Trackline {update.version} is available.</strong> <span className={status === 'error' ? 'update-error' : ''}>{message}</span></p>
      {update.body && <button type="button" className="update-link" onClick={() => setShowNotes(value => !value)} aria-expanded={showNotes}>What’s new <ChevronDown size={13} className={showNotes ? 'rotated' : ''} aria-hidden="true" /></button>}
      <button type="button" className="update-action" onClick={updates.installUpdate} disabled={isWorking}>{isWorking ? <span className="mini-spinner inline" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}{status === 'error' ? 'Try again' : 'Update and restart'}</button>
      {!isWorking && <button type="button" className="update-dismiss" onClick={updates.dismiss} aria-label="Remind me later"><X size={15} /></button>}
    </div>
    {status === 'downloading' && <span className="update-progress" aria-hidden="true"><i style={{ width: `${Math.round(progress * 100)}%` }} /></span>}
    {showNotes && update.body && <ReleaseNotes body={update.body} />}
  </div>;
}

export function UpdateSettings({ updates }: { updates: AppUpdates }) {
  const { currentVersion, status, update, lastChecked, error, isDev } = updates;
  const checkedText = lastChecked ? lastChecked.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const statusText = isDev ? 'Updates are checked in installed builds, not in development.'
    : status === 'checking' ? 'Checking for updates…'
    : status === 'available' && update ? `Version ${update.version} is ready to install.`
    : status === 'downloading' ? 'Downloading the update…'
    : status === 'restarting' ? 'Restarting…'
    : status === 'error' ? error
    : status === 'none' ? `You’re up to date. Last checked at ${checkedText}.`
    : 'Checks automatically when Trackline starts and every few hours.';
  return <div className="update-settings">
    <div className="update-version"><strong>Trackline {currentVersion || '…'}</strong><small className={status === 'error' ? 'invalid' : ''}>{statusText}</small></div>
    <div className="update-buttons">
      <button type="button" className="quiet-action" onClick={updates.checkForUpdates} disabled={isDev || status === 'checking' || status === 'downloading' || status === 'restarting'}><RefreshCw size={14} aria-hidden="true" />Check for updates</button>
      {update && !isDev && <button type="button" className="primary-button" onClick={updates.installUpdate} disabled={status === 'downloading' || status === 'restarting'}><Download size={15} aria-hidden="true" />Update to {update.version}</button>}
    </div>
  </div>;
}
