import { useState } from 'react';
import { del, get, patch, post } from '../lib/api';
import type { PowerSystem } from '../lib/types';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { Empty, ErrorLine, Field, JsonEditor, StreamPanel, useAction, useLoad } from '../components/common';

/*
 * The generator's questionnaire. Ids must match the server's power catalog;
 * the options are only prompts — any free text is accepted as an answer.
 */
const QUESTIONS: Array<{ id: string; q: string; options: string[] }> = [
  { id: 'energy', q: 'What powers abilities?', options: ['qi / spiritual energy', 'mana', 'soul or lifeforce', 'divine grace', 'technology', 'no single energy'] },
  { id: 'ladder', q: 'Shape of the ladder?', options: ['named tiers with breakthroughs', 'numeric levels', 'ranks and orders (knight, master…)', 'grades of a gift people are born with'] },
  { id: 'advancement', q: 'How does one climb?', options: ['accumulation, then a breakthrough', 'trials and deeds', 'bestowed by an institution or being', 'bloodline or talent decides the ceiling'] },
  { id: 'ceiling', q: 'How strong is the top?', options: ['peak human', 'city-shaking', 'nation-shaking', 'world-shaking or cosmic'] },
  { id: 'cost', q: 'What does power cost?', options: ['years of lifespan', 'scarce resources', 'humanity or sanity', 'time and toil only'] },
  { id: 'access', q: 'Who can walk the path?', options: ['anyone who trains', 'the talented few', 'specific bloodlines', 'whoever can pay'] },
  { id: 'institutions', q: 'Who teaches and gatekeeps it?', options: ['sects', 'guilds', 'the state or military', 'churches', 'no one — it is wild knowledge'] },
  { id: 'distribution', q: 'How steep is the pyramid?', options: ['most people have nothing', 'everyone has a little, few have much', 'power is common but mastery is rare'] },
];

export function PowerTab({ base }: TabProps) {
  const systems = useLoad(() => get<{ systems: PowerSystem[] }>(`${base}/power`), [base]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'generate'>('view');
  const [name, setName] = useState('');
  const action = useAction();

  const list = systems.data?.systems ?? [];
  const selected = list.find((s) => s.id === selectedId) ?? null;

  const createBlank = async () => {
    const r = await action.run(() => post<{ system: PowerSystem }>(`${base}/power`, { name }));
    if (r) {
      setName('');
      await systems.reload();
      setSelectedId(r.system.id);
      setMode('view');
    }
  };

  return (
    <div className="split">
      <aside className="sublist">
        <button onClick={() => { setMode('generate'); setSelectedId(null); }}>✦ Design a system with AI</button>
        <div className="card compact">
          <input placeholder="…or a blank one, by name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="ghost" onClick={createBlank} disabled={!name.trim() || action.busy}>
            + Blank system
          </button>
          <ErrorLine text={action.error} />
        </div>
        <ErrorLine text={systems.error} />
        <ul className="entries">
          {list.map((s) => (
            <li key={s.id}>
              <button className={s.id === selectedId ? 'on' : ''} onClick={() => { setSelectedId(s.id); setMode('view'); }}>
                <span className="grow ellipsis">{s.name}</span>
                <span className="tag">{s.ranks.length} ranks</span>
              </button>
            </li>
          ))}
        </ul>
        {list.length === 0 && !systems.loading && <Empty>No power systems yet.</Empty>}
      </aside>
      <div className="pane">
        {mode === 'generate' && (
          <Generator
            base={base}
            onDone={async (id) => { await systems.reload(); setSelectedId(id); setMode('view'); }}
          />
        )}
        {mode === 'view' && selected && (
          <SystemView key={selected.id} base={base} system={selected} onChanged={systems.reload} onDeleted={async () => { setSelectedId(null); await systems.reload(); }} />
        )}
        {mode === 'view' && !selected && <Empty>Pick a system, or design one.</Empty>}
      </div>
    </div>
  );
}

function Generator({ base, onDone }: { base: string; onDone: (id: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [suggestions, setSuggestions] = useState('');
  const stream = useStream();
  const go = async () => {
    const done = (await stream.run(`${base}/power/generate`, {
      answers: Object.entries(answers).map(([id, answer]) => ({ id, answer })),
      suggestions,
    })) as { system: PowerSystem } | null;
    if (done?.system) onDone(done.system.id);
  };
  return (
    <div className="generator">
      <h2>Design a power system</h2>
      <p className="dim small">Answer what you know; anything left blank is the model's call.</p>
      <div className="grid2">
        {QUESTIONS.map((q) => (
          <Field key={q.id} label={q.q}>
            <input
              list={`opts-${q.id}`}
              value={answers[q.id] ?? ''}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            />
            <datalist id={`opts-${q.id}`}>
              {q.options.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </Field>
        ))}
      </div>
      <Field label="Anything else">
        <textarea rows={3} value={suggestions} onChange={(e) => setSuggestions(e.target.value)} />
      </Field>
      <button onClick={go} disabled={stream.running}>
        {stream.running ? 'Designing…' : 'Generate'}
      </button>
      <StreamPanel stream={stream} showText={false} />
    </div>
  );
}

function SystemView({ base, system, onChanged, onDeleted }: { base: string; system: PowerSystem; onChanged: () => void; onDeleted: () => void }) {
  const path = `${base}/power/${encodeURIComponent(system.id)}`;
  const [instructions, setInstructions] = useState('');
  const stream = useStream();
  const action = useAction();

  const editable: Record<string, unknown> = { ...system };
  for (const k of ['id', 'source', 'createdAt', 'updatedAt']) delete editable[k];

  const refine = async () => {
    const done = await stream.run(`${path}/refine`, { instructions });
    if (done) {
      setInstructions('');
      onChanged();
    }
  };

  return (
    <div className="power">
      <div className="row">
        <h2 className="grow">{system.name}</h2>
        <span className="tag">{system.source}</span>
        <button
          className="danger ghost"
          onClick={() => action.run(async () => { if (confirm(`Delete “${system.name}”?`)) { await del(path); onDeleted(); } })}
        >
          Delete
        </button>
      </div>
      <p>{system.summary}</p>
      {system.energyName && <p className="small">Energy: {system.energyName}</p>}
      <ol className="ladder">
        {system.ranks.map((r) => (
          <li key={r.id}>
            <strong>{r.name}</strong> <span className="small dim">{r.summary}</span>
          </li>
        ))}
      </ol>
      {system.openQuestions.length > 0 && (
        <>
          <h3>Open questions</h3>
          <ul className="small">
            {system.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      <div className="card">
        <div className="row">
          <input className="grow" placeholder="Refine: “add a rank between 3 and 4”…" value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          <button onClick={refine} disabled={!instructions.trim() || stream.running}>
            Refine
          </button>
        </div>
        <StreamPanel stream={stream} showText={false} />
      </div>
      <ErrorLine text={action.error} />
      <h3>Edit as JSON</h3>
      <JsonEditor value={editable} rows={24} onSave={async (next) => { await patch(path, next); onChanged(); }} />
    </div>
  );
}
