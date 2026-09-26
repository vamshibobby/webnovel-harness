import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { BIBLE_TYPES, type Usage } from '../lib/types';
import type { TabProps } from '../components/Workspace';
import { ErrorLine, Field, Json, JsonEditor, ModeOff, UsageLine, useAction, useLoad } from '../components/common';

interface Charter {
  cultures: Array<{ id: string; label: string; soundWorldId: string; appliesTo: string }>;
  pack: string;
  banned: string[];
  notes: string;
  source: string;
}

interface NamingState {
  charter: Charter;
  namingMode: string;
  soundWorlds: Array<{ id: string; label?: string; [k: string]: unknown }>;
  packs: Array<{ id: string; label?: string; [k: string]: unknown }>;
}

interface CoinResult {
  proposals: Array<{ name: string; source: string; etymology: string; why: string }>;
  slate: Array<{ name: string; note: string }>;
  usage: Usage | null;
}

export function NamesTab({ base, updateNovel }: TabProps) {
  const naming = useLoad(() => get<NamingState>(`${base}/naming`), [base]);
  const action = useAction();
  const [usage, setUsage] = useState<Usage | null>(null);
  const off = naming.data?.namingMode === 'off';
  const charter = naming.data?.charter;

  return (
    <div className="stack">
      <ErrorLine text={naming.error} />
      {off && (
        <ModeOff
          feature="Name generation"
          onEnable={async () => {
            await updateNovel({ namingMode: 'on' });
            await naming.reload();
          }}
        />
      )}

      {charter && (
        <div className="card">
          <div className="row">
            <h3 className="grow">Naming charter</h3>
            <span className="tag">{charter.source}</span>
            <button
              className="ghost"
              disabled={off || action.busy}
              onClick={() =>
                action.run(async () => {
                  const r = await post<{ usage: Usage }>(`${base}/naming/charter/derive`, {});
                  setUsage(r.usage);
                  await naming.reload();
                })
              }
            >
              Derive from the novel
            </button>
            <button
              className="ghost"
              onClick={() => action.run(async () => { await del(`${base}/naming/charter`); await naming.reload(); })}
            >
              Reset
            </button>
          </div>
          <p className="small dim">
            Packs: {(naming.data?.packs ?? []).map((p) => p.id).join(', ')} · Sound worlds:{' '}
            {(naming.data?.soundWorlds ?? []).map((s) => s.id).join(', ')}
          </p>
          <JsonEditor
            value={{ cultures: charter.cultures, pack: charter.pack, banned: charter.banned, notes: charter.notes }}
            onSave={async (next) => { await patch(`${base}/naming/charter`, next); await naming.reload(); }}
          />
          <UsageLine usage={usage} />
          <ErrorLine text={action.error} />
        </div>
      )}

      {charter && <Coiner base={base} cultures={charter.cultures} disabled={off} />}
      <Rename base={base} />
    </div>
  );
}

function Coiner({ base, cultures, disabled }: { base: string; cultures: Charter['cultures']; disabled: boolean }) {
  const [kind, setKind] = useState('character');
  const [brief, setBrief] = useState('');
  const [culture, setCulture] = useState('');
  const [result, setResult] = useState<CoinResult | null>(null);
  const action = useAction();
  const coin = async () => {
    const r = await action.run(() =>
      post<CoinResult>(`${base}/naming/coin`, {
        kind,
        brief,
        culture: culture || undefined,
        nonce: Math.floor(Math.random() * 1_000_000),
      })
    );
    if (r) setResult(r);
  };
  return (
    <div className="card">
      <h3>Coin a name</h3>
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {BIBLE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={culture} onChange={(e) => setCulture(e.target.value)}>
          <option value="">any culture</option>
          {cultures.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input className="grow" placeholder="Brief: who or what is this?" value={brief} onChange={(e) => setBrief(e.target.value)} />
        <button onClick={coin} disabled={disabled || action.busy}>
          {action.busy ? 'Coining…' : 'Coin'}
        </button>
      </div>
      <ErrorLine text={action.error} />
      {result && (
        <>
          <UsageLine usage={result.usage} />
          {result.proposals.length > 0 && (
            <ul className="names">
              {result.proposals.map((p, i) => (
                <li key={i}>
                  <strong>{p.name}</strong> <span className="dim small">({p.source})</span>
                  <div className="small">{p.etymology}</div>
                  <div className="small dim">{p.why}</div>
                </li>
              ))}
            </ul>
          )}
          <details open={result.proposals.length === 0}>
            <summary className="small">Raw slate ({result.slate.length})</summary>
            <p className="small">
              {result.slate.map((c) => (
                <span key={c.name} className="tag" title={c.note}>
                  {c.name}
                </span>
              ))}
            </p>
          </details>
        </>
      )}
    </div>
  );
}

function Rename({ base }: { base: string }) {
  const [pairs, setPairs] = useState([{ from: '', to: '' }]);
  const [options, setOptions] = useState({ includeChapters: true, includeNovelText: true, renameNovelTitle: false, keepOldAsAlias: false });
  const [plan, setPlan] = useState<unknown>(null);
  const [applied, setApplied] = useState<unknown>(null);
  const action = useAction();
  const body = () => ({ pairs: pairs.filter((p) => p.from.trim() && p.to.trim()), options });

  return (
    <div className="card">
      <h3>Rename across the novel</h3>
      {pairs.map((p, i) => (
        <div key={i} className="row">
          <input placeholder="Old name" value={p.from} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, from: e.target.value } : q)))} />
          <span>→</span>
          <input placeholder="New name" value={p.to} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, to: e.target.value } : q)))} />
          {pairs.length > 1 && (
            <button className="ghost tiny" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>
              ✕
            </button>
          )}
        </div>
      ))}
      <button className="ghost small" onClick={() => setPairs([...pairs, { from: '', to: '' }])}>
        + pair
      </button>
      <div className="row wrap small">
        {(Object.keys(options) as Array<keyof typeof options>).map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={options[k]} onChange={(e) => setOptions({ ...options, [k]: e.target.checked })} /> {k}
          </label>
        ))}
      </div>
      <div className="row">
        <button
          className="ghost"
          disabled={action.busy}
          onClick={() => action.run(async () => { setApplied(null); setPlan((await post<{ plan: unknown }>(`${base}/naming/rename/preview`, body())).plan); })}
        >
          Preview
        </button>
        <button
          disabled={action.busy || !plan}
          onClick={() =>
            action.run(async () => {
              if (!confirm('Apply this rename to the whole novel?')) return;
              const r = await post<{ applied: unknown; plan: unknown }>(`${base}/naming/rename`, body());
              setApplied(r.applied);
              setPlan(r.plan);
            })
          }
        >
          Apply
        </button>
      </div>
      <ErrorLine text={action.error} />
      {applied != null && (
        <Field label="Applied">
          <Json value={applied} />
        </Field>
      )}
      {plan != null && (
        <details open>
          <summary className="small">Plan</summary>
          <Json value={plan} />
        </details>
      )}
    </div>
  );
}
