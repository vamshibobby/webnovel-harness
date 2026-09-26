import { useState } from 'react';
import { downloadJson, get, settings } from '../lib/api';
import { ErrorLine, Field, useAction } from './common';
import { Modal } from './Modal';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState(settings.getKey());
  const [model, setModel] = useState(settings.getModel());
  const [reveal, setReveal] = useState(false);
  const [saved, setSaved] = useState(false);
  const exporter = useAction();

  const save = () => {
    settings.setKey(key);
    settings.setModel(model);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const exportAll = () =>
    exporter.run(async () => {
      const data = await get('/api/account/export');
      downloadJson(`novel-harness-export-${new Date().toISOString().slice(0, 10)}.json`, data);
    });

  return (
    <Modal title="Settings" onClose={onClose}>
      <Field
        label="OpenRouter API key"
        hint="Stored in this browser only and sent to your local server as X-OpenRouter-Key. Leave blank to use a key configured on the server."
      >
        <div className="row">
          <input
            className="grow mono"
            type={reveal ? 'text' : 'password'}
            value={key}
            placeholder="sk-or-…"
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="ghost" onClick={() => setReveal((v) => !v)}>
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      </Field>
      <Field
        label="Default model"
        hint="An OpenRouter model id, e.g. anthropic/claude-sonnet-4. Used for new novels and when a novel has no model of its own."
      >
        <input className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" />
      </Field>
      <div className="row">
        <button onClick={save}>Save</button>
        {saved && <span className="ok">Saved.</span>}
      </div>
      <hr />
      <h3>Your data</h3>
      <p className="dim small">Every novel with its chapters, bible, designs, arcs and map, as one JSON file. Hidden novels are included only while the vault is unlocked.</p>
      <button className="ghost" onClick={exportAll} disabled={exporter.busy}>
        {exporter.busy ? 'Exporting…' : 'Export everything'}
      </button>
      <ErrorLine text={exporter.error} />
    </Modal>
  );
}
