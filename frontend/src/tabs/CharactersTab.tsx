import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import type { BibleEntry, Design } from '../lib/types';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { Empty, ErrorLine, Field, Json, JsonEditor, ModeOff, StreamPanel, useAction, useLoad } from '../components/common';

export function CharactersTab({ base, novel, updateNovel }: TabProps) {
  const designs = useLoad(() => get<{ designs: Design[]; designMode: string }>(`${base}/designs`), [base]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (designs.data && designs.data.designMode === 'off') {
    return (
      <ModeOff
        feature="Character designs"
        onEnable={async () => {
          await updateNovel({ designMode: 'on' });
          await designs.reload();
        }}
      />
    );
  }

  const list = designs.data?.designs ?? [];
  const selected = list.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="split">
      <aside className="sublist">
        <NewDesign base={base} onCreated={async (id) => { await designs.reload(); setSelectedId(id); }} />
        <ErrorLine text={designs.error} />
        <ul className="entries">
          {list.map((d) => (
            <li key={d.id}>
              <button className={d.id === selectedId ? 'on' : ''} onClick={() => setSelectedId(d.id)}>
                <span className="grow ellipsis">{d.name}</span>
                <span className={`tag ${d.state}`}>{d.state}</span>
                {d.steer && <span className="tag">steer</span>}
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && !designs.loading && <Empty>No designs yet.</Empty>}
        <button className="ghost small" onClick={() => updateNovel({ designMode: 'off' }).then(designs.reload)}>
          Turn designs off
        </button>
      </aside>
      <div className="pane">
        {selected ? (
          <DesignView
            key={selected.id}
            base={base}
            design={selected}
            chapters={novel.chapterCount}
            onChanged={designs.reload}
            onDeleted={async () => { setSelectedId(null); await designs.reload(); }}
          />
        ) : (
          <Empty>Pick a character, or create one — blank or seeded from the story bible.</Empty>
        )}
      </div>
    </div>
  );
}

function NewDesign({ base, onCreated }: { base: string; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [fromEntryId, setFrom] = useState('');
  const bible = useLoad(() => get<{ entries: BibleEntry[] }>(`${base}/bible`), [base]);
  const action = useAction();
  const characters = (bible.data?.entries ?? []).filter((e) => e.type === 'character');
  const create = async () => {
    const r = await action.run(() =>
      post<{ design: Design }>(`${base}/designs`, fromEntryId ? { fromEntryId } : { name })
    );
    if (r) {
      setName('');
      setFrom('');
      onCreated(r.design.id);
    }
  };
  return (
    <div className="card compact">
      <input placeholder="New character name" value={name} onChange={(e) => setName(e.target.value)} disabled={!!fromEntryId} />
      <select value={fromEntryId} onChange={(e) => setFrom(e.target.value)}>
        <option value="">…or seed from bible</option>
        {characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <button onClick={create} disabled={action.busy || (!name.trim() && !fromEntryId)}>
        + Design
      </button>
      <ErrorLine text={action.error} />
    </div>
  );
}

function DesignView({
  base,
  design,
  chapters,
  onChanged,
  onDeleted,
}: {
  base: string;
  design: Design;
  chapters: number;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const path = `${base}/designs/${encodeURIComponent(design.id)}`;
  const action = useAction();
  const stream = useStream();
  const [instructions, setInstructions] = useState('');
  const [report, setReport] = useState<unknown>(null);

  // The PATCH-able sheet; state and steer have their own controls above.
  const fields = {
    name: design.name,
    linkedEntryId: design.linkedEntryId ?? null,
    essentials: design.essentials,
    motivation: design.motivation,
    personality: design.personality,
    history: design.history,
    arcs: design.arcs,
    relationships: design.relationships,
    notes: design.notes,
  };

  const assist = async () => {
    const done = await stream.run(`${path}/assist`, { instructions });
    if (done) onChanged();
  };
  const drift = async () => {
    setReport(null);
    await stream.run(`${path}/drift`, {}, (event, data) => {
      if (event === 'report') setReport(data);
    });
  };

  return (
    <div className="design">
      <div className="row">
        <h2 className="grow">{design.name}</h2>
        <select
          value={design.state}
          onChange={(e) => action.run(async () => { await patch(path, { state: e.target.value }); onChanged(); })}
        >
          <option value="draft">draft</option>
          <option value="active">active (reaches generation)</option>
          <option value="retired">retired</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={design.steer}
            onChange={(e) => action.run(async () => { await patch(path, { steer: e.target.checked }); onChanged(); })}
          />
          steer
        </label>
        <button
          className="danger ghost"
          onClick={() => action.run(async () => { if (confirm(`Delete design “${design.name}”?`)) { await del(path); onDeleted(); } })}
        >
          Delete
        </button>
      </div>
      <ErrorLine text={action.error} />

      <div className="card">
        <Field label="Ask the design assistant" hint="It fills gaps and sharpens the sheet; leave blank for a general pass.">
          <textarea rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>
        <div className="row">
          <button onClick={assist} disabled={stream.running}>
            Assist
          </button>
          <button className="ghost" onClick={drift} disabled={stream.running || chapters === 0}>
            Check drift against the story
          </button>
        </div>
        <StreamPanel stream={stream} showText={false} />
        {report != null && (
          <div className="card">
            <h3>Drift report</h3>
            <Json value={report} />
          </div>
        )}
      </div>

      <h3>Design sheet</h3>
      <JsonEditor value={fields} rows={24} onSave={async (next) => { await patch(path, next); onChanged(); }} />
    </div>
  );
}
