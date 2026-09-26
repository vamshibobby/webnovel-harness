import { useState } from 'react';
import { get, post, settings } from '../lib/api';
import { go } from '../lib/router';
import type { Novel, StyleInfo } from '../lib/types';
import { ErrorLine, Field, useAction, useLoad } from './common';

interface Props {
  novels: Novel[];
  error: string;
  activeId: string | null;
  onChanged: () => void;
  onSettings: () => void;
  onVault: () => void;
}

export function Rail({ novels, error, activeId, onChanged, onSettings, onVault }: Props) {
  const [creating, setCreating] = useState(false);
  return (
    <aside className="rail">
      <div className="brand" onClick={() => go(null)}>
        <span className="brand-mark">¶</span> Novel Harness
      </div>
      <button className="new" onClick={() => setCreating((v) => !v)}>
        {creating ? 'Cancel' : '+ New novel'}
      </button>
      {creating && (
        <NewNovel
          onCreated={(id) => {
            setCreating(false);
            onChanged();
            go(id, 'write');
          }}
        />
      )}
      <ErrorLine text={error} />
      <nav className="shelf">
        {novels.map((n) => (
          <button key={n.id} className={`spine ${n.id === activeId ? 'active' : ''}`} onClick={() => go(n.id, 'write')}>
            {n.coverUrl ? <img src={n.coverUrl} alt="" /> : <span className="spine-letter">{n.title.slice(0, 1)}</span>}
            <span className="spine-text">
              <span className="spine-title">{n.title}</span>
              <span className="dim small">
                {n.chapterCount} ch · {n.wordCount.toLocaleString()} words
              </span>
            </span>
          </button>
        ))}
        {novels.length === 0 && !error && <p className="dim small pad">No novels yet.</p>}
      </nav>
      <div className="rail-foot">
        <button className="ghost" onClick={onVault}>
          Vault
        </button>
        <button className="ghost" onClick={onSettings}>
          Settings
        </button>
      </div>
    </aside>
  );
}

function NewNovel({ onCreated }: { onCreated: (id: string) => void }) {
  const styles = useLoad(() => get<StyleInfo[]>('/api/styles'), []);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [style, setStyle] = useState('');
  const [length, setLength] = useState('');
  const [hidden, setHidden] = useState(false);
  const action = useAction();

  const submit = async () => {
    const novel = await action.run(() =>
      post<Novel>('/api/novels', {
        title,
        premise,
        style: style || undefined,
        defaultModel: settings.getModel() || undefined,
        chapterLength: length ? Number(length) : undefined,
        hidden,
      })
    );
    if (novel) onCreated(novel.id);
  };

  return (
    <div className="card new-form">
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </Field>
      <Field label="Premise">
        <textarea rows={4} value={premise} onChange={(e) => setPremise(e.target.value)} />
      </Field>
      <Field label="Style" hint="Fixed for the life of the novel.">
        <select value={style} onChange={(e) => setStyle(e.target.value)}>
          <option value="">(server default)</option>
          {(styles.data ?? []).map((s) => (
            <option key={s.key} value={s.key} title={s.blurb}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Words per chapter" hint="Blank lets the model decide.">
        <input type="number" value={length} onChange={(e) => setLength(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Create inside the vault
      </label>
      <button onClick={submit} disabled={!title.trim() || action.busy}>
        {action.busy ? 'Creating…' : 'Create'}
      </button>
      <ErrorLine text={action.error} />
    </div>
  );
}
