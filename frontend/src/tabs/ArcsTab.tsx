import { useEffect, useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import type { Blueprint, CastProposal, StoryArc, Usage } from '../lib/types';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { Empty, ErrorLine, Field, JsonEditor, ModeOff, StreamPanel, UsageLine, useAction, useLoad } from '../components/common';

interface ArcList {
  arcs: StoryArc[];
  arcMode: string;
  chapterCount: number;
}

export function ArcsTab({ base, updateNovel }: TabProps) {
  const arcs = useLoad(() => get<ArcList>(`${base}/arcs`), [base]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const action = useAction();

  if (arcs.data && arcs.data.arcMode === 'off') {
    return (
      <ModeOff
        feature="Arc planning"
        onEnable={async () => {
          await updateNovel({ arcMode: 'on' });
          await arcs.reload();
        }}
      />
    );
  }

  const list = arcs.data?.arcs ?? [];
  const selected = list.find((a) => a.id === selectedId) ?? null;

  const create = async () => {
    const r = await action.run(() => post<{ arc: StoryArc }>(`${base}/arcs`, { title, premise }));
    if (r) {
      setTitle('');
      setPremise('');
      await arcs.reload();
      setSelectedId(r.arc.id);
    }
  };

  return (
    <div className="split">
      <aside className="sublist">
        <div className="card compact">
          <input placeholder="New arc title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea rows={3} placeholder="What happens in this arc?" value={premise} onChange={(e) => setPremise(e.target.value)} />
          <button onClick={create} disabled={!title.trim() || action.busy}>
            + Arc
          </button>
          <ErrorLine text={action.error} />
        </div>
        <ErrorLine text={arcs.error} />
        <ul className="entries">
          {list.map((a) => (
            <li key={a.id}>
              <button className={a.id === selectedId ? 'on' : ''} onClick={() => setSelectedId(a.id)}>
                <span className="num">{a.number}</span>
                <span className="grow ellipsis">{a.title}</span>
                <span className="dim small">
                  {a.fromChapter}–{a.toChapter}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && !arcs.loading && <Empty>No arcs yet.</Empty>}
        <div className="dim small">Chapters written: {arcs.data?.chapterCount ?? 0}</div>
        <button className="ghost small" onClick={() => updateNovel({ arcMode: 'off' }).then(arcs.reload)}>
          Turn arc planning off
        </button>
      </aside>
      <div className="pane">
        {selected ? (
          <ArcView
            key={selected.id}
            base={base}
            arc={selected}
            written={arcs.data?.chapterCount ?? 0}
            onChanged={arcs.reload}
            onDeleted={async () => { setSelectedId(null); await arcs.reload(); }}
          />
        ) : (
          <Empty>Pick an arc. The pipeline is: describe → refine into beats → plan chapters → name the cast.</Empty>
        )}
      </div>
    </div>
  );
}

function ArcView({
  base,
  arc,
  written,
  onChanged,
  onDeleted,
}: {
  base: string;
  arc: StoryArc;
  written: number;
  onChanged: () => Promise<void>;
  onDeleted: () => void;
}) {
  const path = `${base}/arcs/${encodeURIComponent(arc.id)}`;
  const action = useAction();
  const stream = useStream();
  const [meta, setMeta] = useState({ title: arc.title, premise: arc.premise, fromChapter: arc.fromChapter, toChapter: arc.toChapter, status: arc.status, steer: arc.steer });
  const [refineNote, setRefineNote] = useState('');
  const [editNote, setEditNote] = useState('');
  const [editChapter, setEditChapter] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [planCount, setPlanCount] = useState('5');
  const [planFrom, setPlanFrom] = useState('');
  const [live, setLive] = useState<Blueprint[]>([]);
  const [cast, setCast] = useState<CastProposal | null>(null);

  // A refine or AI edit rewrites the premise server-side; follow it.
  useEffect(() => {
    setMeta({ title: arc.title, premise: arc.premise, fromChapter: arc.fromChapter, toChapter: arc.toChapter, status: arc.status, steer: arc.steer });
  }, [arc.title, arc.premise, arc.fromChapter, arc.toChapter, arc.status, arc.steer]);

  const saveMeta = () => action.run(async () => { await patch(path, meta); await onChanged(); });

  const refine = () =>
    action.run(async () => {
      const r = await post<{ arc: StoryArc; usage: Usage }>(`${path}/refine`, { instructions: refineNote });
      setUsage(r.usage);
      await onChanged();
    });

  const aiEdit = () =>
    action.run(async () => {
      const r = await post<{ arc: StoryArc; usage: Usage }>(`${path}/edit`, {
        instruction: editNote,
        chapter: editChapter ? Number(editChapter) : undefined,
      });
      setUsage(r.usage);
      setEditNote('');
      await onChanged();
    });

  const plan = async () => {
    setLive([]);
    await stream.run(
      `${path}/blueprints`,
      { count: Number(planCount) || undefined, from: planFrom ? Number(planFrom) : undefined },
      (event, data) => {
        if (event === 'blueprint') setLive((l) => [...l, data as Blueprint]);
      }
    );
    await onChanged();
  };

  const castPass = async () => {
    setCast(null);
    await stream.run(`${path}/cast`, {}, (event, data) => {
      if (event === 'cast') setCast(data as CastProposal);
    });
  };

  const acceptCast = () =>
    action.run(async () => {
      if (!cast) return;
      await post(`${path}/cast/accept`, {
        members: cast.members.map((m) => ({
          entryId: m.entryId,
          name: m.name,
          kind: m.kind,
          role: m.role,
          brief: m.brief,
          mentions: m.mentions,
          chapters: m.chapters,
        })),
        context: cast.context,
      });
      setCast(null);
      await onChanged();
    });

  return (
    <div className="arc">
      <div className="row">
        <h2 className="grow">
          Arc {arc.number}: {arc.title}
        </h2>
        <button
          className="danger ghost"
          onClick={() => action.run(async () => { if (confirm(`Delete arc “${arc.title}”?`)) { await del(path); onDeleted(); } })}
        >
          Delete
        </button>
      </div>

      <div className="card">
        <div className="grid2">
          <Field label="Title">
            <input value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
          </Field>
          <Field label="Status">
            <select value={meta.status} onChange={(e) => setMeta({ ...meta, status: e.target.value as StoryArc['status'] })}>
              {['planning', 'active', 'done', 'abandoned'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="From chapter">
            <input type="number" value={meta.fromChapter} onChange={(e) => setMeta({ ...meta, fromChapter: Number(e.target.value) })} />
          </Field>
          <Field label="To chapter">
            <input type="number" value={meta.toChapter} onChange={(e) => setMeta({ ...meta, toChapter: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Premise">
          <textarea rows={5} value={meta.premise} onChange={(e) => setMeta({ ...meta, premise: e.target.value })} />
        </Field>
        {arc.previousPremise && (
          <details>
            <summary className="small">Your earlier premise (before refine)</summary>
            <p className="small dim">{arc.previousPremise}</p>
          </details>
        )}
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={meta.steer} onChange={(e) => setMeta({ ...meta, steer: e.target.checked })} /> steer generation with this arc
          </label>
          <span className="grow" />
          <button onClick={saveMeta} disabled={action.busy}>
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <h3>1 · Refine into beats</h3>
        <div className="row">
          <input className="grow" placeholder="Optional instructions for the refine" value={refineNote} onChange={(e) => setRefineNote(e.target.value)} />
          <button onClick={refine} disabled={action.busy}>
            {action.busy ? 'Working…' : 'Refine'}
          </button>
        </div>
        {arc.threads && arc.threads.length > 0 && (
          <p className="small">
            Threads: {arc.threads.map((t) => <span key={t.id} className="tag">{t.label} ({t.anchor})</span>)}
          </p>
        )}
        <ol className="beats">
          {arc.beats.map((b) => (
            <li key={b.id} className={b.source}>
              {b.text}
              {b.previousText && <span className="dim small"> (was: {b.previousText})</span>}
            </li>
          ))}
        </ol>
        {arc.nameFlags && arc.nameFlags.length > 0 && (
          <div className="warn small">Unagreed names: {arc.nameFlags.map((f) => f.name).join(', ')}</div>
        )}
        <details>
          <summary className="small">Edit beats / threads / timeline as JSON</summary>
          <JsonEditor
            value={{ beats: arc.beats, threads: arc.threads ?? [], nameFlags: arc.nameFlags ?? [] }}
            onSave={async (next) => { await patch(path, next); await onChanged(); }}
          />
        </details>
      </div>

      <div className="card">
        <h3>2 · Plan chapters</h3>
        <div className="row">
          <Field label="How many">
            <input type="number" value={planCount} onChange={(e) => setPlanCount(e.target.value)} />
          </Field>
          <Field label="Starting at" hint="Blank: first unplanned chapter">
            <input type="number" value={planFrom} onChange={(e) => setPlanFrom(e.target.value)} />
          </Field>
          <button onClick={plan} disabled={stream.running || arc.beats.length === 0}>
            Plan
          </button>
          <button className="ghost" onClick={castPass} disabled={stream.running || arc.blueprints.length === 0}>
            Name the cast
          </button>
        </div>
        {arc.beats.length === 0 && <p className="dim small">Refine the arc into beats first.</p>}
        <StreamPanel stream={stream} showText={false} />
        {live.length > 0 && stream.running && <p className="small">{live.length} chapter(s) planned so far…</p>}

        {cast && (
          <div className="card cast">
            <h3>Cast proposal (chapters {cast.from}–{cast.to})</h3>
            {cast.members.length === 0 && <p className="small">No one to name.</p>}
            {cast.members.map((m, i) => (
              <div key={m.id} className="row small">
                <input
                  value={m.name}
                  onChange={(e) => {
                    const members = [...cast.members];
                    members[i] = { ...m, name: e.target.value };
                    setCast({ ...cast, members });
                  }}
                />
                <span className="grow">
                  {m.role} <span className="dim">· ch {m.chapters.join(', ')}</span>
                  {(m.alternatives ?? []).length > 0 && <span className="dim"> · alt: {m.alternatives.join(', ')}</span>}
                </span>
              </div>
            ))}
            <div className="row">
              <button onClick={acceptCast} disabled={action.busy}>
                Accept cast
              </button>
              <button className="ghost" onClick={() => setCast(null)}>
                Discard
              </button>
            </div>
          </div>
        )}

        <table className="blueprints">
          <thead>
            <tr>
              <th>Ch</th>
              <th>Title</th>
              <th>Plan</th>
              <th>Cast</th>
            </tr>
          </thead>
          <tbody>
            {[...arc.blueprints].sort((a, b) => a.chapter - b.chapter).map((b) => (
              <tr key={b.chapter} className={b.chapter <= written ? 'written' : ''}>
                <td>{b.chapter}</td>
                <td>
                  {b.title}
                  <div className="dim small">{(b.tags ?? []).join(' · ')}</div>
                </td>
                <td className="small">{b.summary}</td>
                <td className="small">{(b.cast ?? []).map((c) => c.name).join(', ') || (b.roles ?? []).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>AI edit</h3>
        <div className="row">
          <input className="grow" placeholder="Say what should change in the plan" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
          <input className="narrow" type="number" placeholder="ch" value={editChapter} onChange={(e) => setEditChapter(e.target.value)} />
          <button onClick={aiEdit} disabled={!editNote.trim() || action.busy}>
            Apply
          </button>
        </div>
      </div>

      {arc.braid && (
        <div className="card">
          <h3>Braid report</h3>
          <p className="small">
            weave rate {(arc.braid.weaveRate * 100).toFixed(0)}% · longest single-thread run {arc.braid.longestRun}
          </p>
          <ul className="small">
            {arc.braid.findings.map((f, i) => (
              <li key={i} className={f.severity}>
                {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {arc.stages && (
        <p className="dim small">
          Stages:{' '}
          {Object.entries(arc.stages).map(([k, v]) => `${k} ${v.status}${v.message ? ` (${v.message})` : ''}`).join(' · ')}
        </p>
      )}

      <UsageLine usage={usage} />
      <ErrorLine text={action.error} />
    </div>
  );
}
