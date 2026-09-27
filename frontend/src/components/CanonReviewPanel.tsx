import { useState } from 'react';
import type { CanonProposal, ModelRun } from '../lib/harnessTypes';
export function CanonReviewPanel({ proposal, stale, runs, accepted, disabled = false, onExtract, onReview, onRefresh }: { disabled?: boolean; accepted: boolean; proposal?: CanonProposal; stale?: boolean; runs?: ModelRun[]; onExtract: () => Promise<void>; onReview: (accept: boolean) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not complete this action'); } finally { setBusy(false); } };
  return <details className="harness-panel my-4 rounded-lg border border-line p-3" open={proposal?.state === 'pending' || stale || undefined}>
    <summary className="font-medium">Canon and memory {proposal?.state === 'pending' ? '· review needed' : stale ? '· refresh needed' : ''}</summary>
    {disabled && <p className="mt-2 text-sm">Save your edits before reviewing or refreshing memory.</p>}
    {stale && <p className="mt-2 text-sm">The text changed. Its old summary and extracted state have been invalidated. Refresh memory, then review affected later chapters.</p>}
    {proposal?.state === 'pending' && <div className="mt-3 space-y-3">
      {proposal.changes.map((change, index) => <section key={`${change.entryId}-${index}`} className="rounded border border-line p-2 text-sm">
        <strong>{change.name}</strong>
        {change.conflicts.map((c, i) => <p key={i} className="text-warn-ink">{c}</p>)}
        {change.patch.aliases?.length ? <p>Aliases: {change.patch.aliases.join(', ')}</p> : null}
        {change.patch.removeFacts?.map(f => <p key={f}>Remove recorded fact: {f}</p>)}
        {change.patch.relationships && <p>Relationships: {change.patch.relationships.length ? change.patch.relationships.map(r => `${r.nature} → ${r.targetId}`).join('; ') : 'none'}</p>}
        {change.patch.status && <p>Status: {change.patch.status}</p>}
        {change.patch.summary && <p>{change.patch.summary}</p>}
        {Object.entries(change.patch.attributes ?? {}).map(([key, value]) => <p key={key}>{key}: {value}</p>)}
        {change.patch.newFacts?.map((f, i) => <p key={i}>+ {f.text}{f.evidence && <q className="ml-2 text-muted">{f.evidence}</q>}</p>)}
        {change.patch.newKnowledge?.map(k => <p key={k.id}>{k.kind}: {k.fact} · {k.via}<br /><q className="text-muted">{k.evidence}</q></p>)}
        {change.patch.evidence && <blockquote className="mt-1 border-l-2 pl-2 text-muted">{change.patch.evidence}</blockquote>}
      </section>)}
      {proposal.powerChanges?.map(p => <details key={p.id}><summary>Power system changes: {p.name}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(p.next, null, 2)}</pre></details>)}
      {!proposal.changes.length && !proposal.powerChanges?.length && <p>No new canon was found.</p>}
      <button type="button" className="mr-3 underline" disabled={busy || disabled} onClick={() => void act(() => onReview(true))}>Approve canon changes</button>
      <button type="button" className="underline" disabled={busy || disabled} onClick={() => void act(() => onReview(false))}>Keep existing canon</button>
    </div>}
    <div className="mt-3 flex flex-wrap gap-3 text-sm">
      <button type="button" className="underline" disabled={busy || disabled} onClick={() => void act(onExtract)}>Preview canon extraction</button>
      <button type="button" className="underline" disabled={busy || disabled || !accepted} title={accepted ? undefined : 'Accept the chapter first'} onClick={() => void act(onRefresh)}>Refresh memory / retry upkeep</button>
      {busy && <span role="status">Working…</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-danger-ink">{error}</p>}
    {!!runs?.length && <details className="mt-3 text-xs"><summary>Generation record</summary>{runs.map((r, i) => <p key={i}>{r.role} · {r.model} · {r.provider || 'provider unavailable'} · {r.cost === null ? 'cost unknown' : `$${r.cost.toFixed(5)}`} · {r.promptTokens.toLocaleString()} in / {r.completionTokens.toLocaleString()} out · {(r.durationMs / 1000).toFixed(1)}s · {r.outcome}<br />Prompt {r.promptVersion} · {r.promptHash.slice(0, 12)}</p>)}</details>}
  </details>;
}
