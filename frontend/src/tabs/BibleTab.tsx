import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import { BIBLE_TYPES, type BibleEntry } from '../lib/types';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { Empty, ErrorLine, Field, JsonEditor, StreamPanel, useAction, useLoad } from '../components/common';

interface BibleList {
  entries: BibleEntry[];
  bibleMode: 'off' | 'accept' | 'batch';
  bibleChapter: number;
}

export function BibleTab({ base, novel, updateNovel }: TabProps) {
  const bible = useLoad(() => get<BibleList>(`${base}/bible`), [base]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const stream = useStream();

  const entries = bible.data?.entries ?? [];
  const shown = entries.filter(
    (e) => !filter || e.type === filter || e.name.toLowerCase().includes(filter.toLowerCase())
  );
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const catchUp = async () => {
    await stream.run(`${base}/bible/update`, {});
    await bible.reload();
  };

  return (
    <div className="split">
      <aside className="sublist">
        <div className="row small">
          <span>Mode:</span>
          <select value={bible.data?.bibleMode ?? novel.bibleMode ?? 'accept'} onChange={async (e) => { await updateNovel({ bibleMode: e.target.value as BibleList['bibleMode'] }); await bible.reload(); }}>
            <option value="accept">update on accept</option>
            <option value="batch">batch catch-up</option>
            <option value="off">off</option>
          </select>
        </div>
        <div className="dim small">Reflects chapters up to {bible.data?.bibleChapter ?? 0} of {novel.chapterCount}.</div>
        <button className="ghost" onClick={catchUp} disabled={stream.running || bible.data?.bibleMode === 'off'}>
          Catch up from chapter {(bible.data?.bibleChapter ?? 0) + 1}
        </button>
        <div className="row">
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">all types</option>
            {BIBLE_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button onClick={() => { setCreating(true); setSelectedId(null); }}>+ Entry</button>
        </div>
        <ErrorLine text={bible.error} />
        <ul className="entries">
          {shown.map((e) => (
            <li key={e.id}>
              <button className={e.id === selectedId ? 'on' : ''} onClick={() => { setSelectedId(e.id); setCreating(false); }}>
                <span className="grow ellipsis">{e.name}</span>
                <span className="tag">{e.type}</span>
              </button>
            </li>
          ))}
        </ul>
        {entries.length === 0 && !bible.loading && <Empty>The bible fills in as chapters are accepted.</Empty>}
      </aside>
      <div className="pane">
        <StreamPanel stream={stream} showText={false} title="bible catch-up" />
        {creating && <NewEntry base={base} onCreated={async (id) => { setCreating(false); await bible.reload(); setSelectedId(id); }} />}
        {selected && <EntryView key={selected.id} base={base} entry={selected} onChanged={bible.reload} onDeleted={async () => { setSelectedId(null); await bible.reload(); }} />}
        {!creating && !selected && <Empty>Pick an entry, or add one by hand.</Empty>}
      </div>
    </div>
  );
}

function NewEntry({ base, onCreated }: { base: string; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('character');
  const [summary, setSummary] = useState('');
  const action = useAction();
  const create = async () => {
    const r = await action.run(() => post<{ entry: BibleEntry }>(`${base}/bible`, { name, type, summary }));
    if (r) onCreated(r.entry.id);
  };
  return (
    <div className="card">
      <h3>New bible entry</h3>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {BIBLE_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label="Summary">
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <button onClick={create} disabled={!name.trim() || action.busy}>
        Create
      </button>
      <ErrorLine text={action.error} />
    </div>
  );
}

function EntryView({ base, entry, onChanged, onDeleted }: { base: string; entry: BibleEntry; onChanged: () => void; onDeleted: () => void }) {
  const [fact, setFact] = useState('');
  const action = useAction();
  const path = `${base}/bible/${encodeURIComponent(entry.id)}`;
  const editable = {
    type: entry.type,
    name: entry.name,
    aliases: entry.aliases,
    summary: entry.summary,
    status: entry.status,
    attributes: entry.attributes,
    relationships: entry.relationships,
  };

  return (
    <div className="entry">
      <div className="row">
        <h2 className="grow">{entry.name}</h2>
        <span className="tag">{entry.type}</span>
        <span className="dim small">since ch {entry.firstChapter}</span>
        <button
          className="danger ghost"
          onClick={() => action.run(async () => { if (confirm(`Delete “${entry.name}”?`)) { await del(path); onDeleted(); } })}
        >
          Delete
        </button>
      </div>
      <p>{entry.summary}</p>
      <h3>Facts</h3>
      <ul className="facts">
        {entry.facts.map((f, i) => (
          <li key={i}>
            <span className="dim small">ch {f.chapter}</span> {f.text}
            <button
              className="ghost tiny"
              title="Remove fact"
              onClick={() => action.run(async () => { await patch(path, { removeFacts: [f.text] }); onChanged(); })}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input className="grow" placeholder="Add a fact…" value={fact} onChange={(e) => setFact(e.target.value)} />
        <button
          disabled={!fact.trim()}
          onClick={() => action.run(async () => { await patch(path, { newFacts: [fact] }); setFact(''); onChanged(); })}
        >
          Add
        </button>
      </div>
      <ErrorLine text={action.error} />
      <h3>Edit fields</h3>
      <JsonEditor value={editable} onSave={async (next) => { await patch(path, next); onChanged(); }} />
    </div>
  );
}
