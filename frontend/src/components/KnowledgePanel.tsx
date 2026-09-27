import { useState } from 'react';
import type { Knowledge } from '../lib/harnessTypes';
export function KnowledgePanel({ records = [], needsReview, onAdd }: { records?: Knowledge[]; needsReview?: boolean; onAdd: (record: Omit<Knowledge, 'id' | 'learnedChapter'>) => Promise<void> }) {
  const [kind, setKind] = useState<Knowledge['kind']>('knows');
  const [fact, setFact] = useState('');
  const [via, setVia] = useState('');
  const [evidence, setEvidence] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="harness-panel my-4 rounded-lg border border-line p-3">
    <h3 className="font-medium">What this character knows</h3>
    {needsReview && <p className="text-warn-ink">Earlier source text changed. Check this entry’s legacy state before relying on it.</p>}
    {!records.length && <p className="text-sm text-muted">No knowledge has been recorded. This does not mean the character knows every world fact.</p>}
    {records.map(k => <div className="my-2 border-b border-line pb-2 text-sm" key={k.id}><strong>{k.kind}</strong>: {k.fact}<p>Chapter {k.learnedChapter} · {k.via}</p><q className="text-muted">{k.evidence}</q></div>)}
    <details className="mt-3"><summary>Add or correct knowledge</summary>
      <label className="mt-2 block">State<select aria-label="State" className="ml-2 rounded border border-line p-1" value={kind} onChange={e => setKind(e.target.value as Knowledge['kind'])}>{['knows', 'believes', 'unaware', 'secret'].map(k => <option key={k}>{k}</option>)}</select></label>
      <label className="mt-2 block">Fact or belief<textarea aria-label="Fact or belief" className="w-full rounded border border-line p-1" maxLength={500} value={fact} onChange={e => setFact(e.target.value)} /></label>
      <label className="mt-2 block">How it reached them<input aria-label="How it reached them" className="w-full rounded border border-line p-1" maxLength={300} value={via} onChange={e => setVia(e.target.value)} /></label>
      <label className="mt-2 block">Supporting passage or author note<textarea aria-label="Supporting passage or author note" className="w-full rounded border border-line p-1" maxLength={800} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      <label className="mt-2 block">Corrects<select aria-label="Corrects" className="w-full rounded border border-line p-1" value={supersedes} onChange={e => setSupersedes(e.target.value)}><option value="">New knowledge</option>{records.map(k => <option key={k.id} value={k.id}>{k.kind}: {k.fact}</option>)}</select></label>
      <button type="button" className="mt-2 underline" disabled={busy || !fact.trim() || !via.trim() || !evidence.trim()} onClick={async () => { setBusy(true); setError(''); try { await onAdd({ kind, fact, via, evidence, ...(supersedes ? { supersedes } : {}) }); setFact(''); setVia(''); setEvidence(''); setSupersedes(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save knowledge'); } finally { setBusy(false); } }}>Save knowledge</button>
      {error && <p role="alert">{error}</p>}
    </details>
  </section>;
}
