import { useEffect, useState } from 'react';
import type { NovelJob } from '../lib/harnessTypes';
export function JobRecovery({ scope, load, cancel, resume }: { scope: string; load: () => Promise<NovelJob[]>; cancel: (id: string) => Promise<void>; resume: (job: NovelJob) => Promise<void> }) {
  const [jobs, setJobs] = useState<NovelJob[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let active = true;
    const refresh = () => load().then(list => { if (active) setJobs(list.filter(j => j.status !== 'done')); }).catch(e => { if (active) setError(e.message); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [scope, load]);
  const act = async (j: NovelJob, action: () => Promise<void>) => { setBusy(j.id); setError(''); try { await action(); setJobs((await load()).filter(j => j.status !== 'done')); } catch (e) { setError(e instanceof Error ? e.message : 'Job failed'); } finally { setBusy(''); } };
  if (!jobs.length && !error) return null;
  return <details className="harness-panel my-3 rounded border border-line p-3 text-sm"><summary>Jobs and recovery ({jobs.length})</summary>
    {jobs.map(j => <div className="mt-3" key={j.id}><strong>Chapter {j.chapter} · {j.mode} · {j.status}</strong>{j.error && <p>{j.error}</p>}
      {j.stages && <p>{Object.entries(j.stages).map(([k,v]) => `${k}: ${v}`).join(' · ')}</p>}
      {j.text && j.status !== 'running' && <details><summary>Recoverable text</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{j.text}</pre></details>}
      <button type="button" className="mr-3 underline" disabled={!!busy || j.status === 'running'} onClick={() => void act(j, () => resume(j))}>Resume {j.mode === 'upkeep' ? 'upkeep' : 'from checkpoint'}</button>
      {j.status === 'running' && <button type="button" className="underline" disabled={!!busy} onClick={() => void act(j, () => cancel(j.id))}>Stop job</button>}
    </div>)}
    {busy && <p role="status">Working…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
