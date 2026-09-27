import { useEffect, useState } from 'react';

interface Draft { title: string; content: string; updatedAt: number }
export const draftKey = (scope: string) => `webnovel:draft:${scope}`;
export function readDraft(scope: string): Draft | null {
  try { const d = JSON.parse(localStorage.getItem(draftKey(scope)) || 'null'); return d && typeof d.title === 'string' && typeof d.content === 'string' && typeof d.updatedAt === 'number' ? d : null; } catch { return null; }
}
export function clearDraft(scope: string) { try { localStorage.removeItem(draftKey(scope)); } catch { /* unavailable storage */ } }
export function DraftRecovery({ scope, saved, title, content, onRestore }: { scope: string; saved: Draft; title: string; content: string; onRestore: (draft: Draft) => void }) {
  const [recovery, setRecovery] = useState(() => { const d = readDraft(scope); return d && (d.title !== saved.title || d.content !== saved.content) ? d : null; });
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (recovery) return;
    if (title === saved.title && content === saved.content) { clearDraft(scope); setMessage(''); return; }
    const timer = setTimeout(() => {
      try { localStorage.setItem(draftKey(scope), JSON.stringify({ title, content, updatedAt: saved.updatedAt })); setMessage('Draft saved on this device.'); }
      catch { setMessage('Device storage is unavailable. Save your edits before leaving.'); }
    }, 400);
    return () => clearTimeout(timer);
  }, [scope, saved.title, saved.content, saved.updatedAt, title, content, recovery]);
  return <div className="harness-panel my-2 rounded border border-line p-2 text-sm" role="status">
    {recovery ? <><p>{recovery.updatedAt === saved.updatedAt ? 'An unsaved draft is available on this device.' : 'A local draft was made from an older chapter version. Restore it to compare before saving.'}</p><button type="button" className="mr-3 underline" onClick={() => { onRestore(recovery); setRecovery(null); }}>Restore local draft</button><button type="button" className="underline" onClick={() => { clearDraft(scope); setRecovery(null); }}>Discard local draft</button></> : message || 'Edits are backed up on this device while you write.'}
  </div>;
}
