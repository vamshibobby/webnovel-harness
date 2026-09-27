import { HarnessSettings } from '../components/HarnessSettings';
import { useState, type ChangeEvent } from 'react';
import { del, downloadJson, get, post, settings } from '../lib/api';
import { go } from '../lib/router';
import type { Novel } from '../lib/types';
import type { TabProps } from '../components/Workspace';
import { ErrorLine, Field, useAction } from '../components/common';

export function NovelSettingsTab({ novel, base, updateNovel, onNovelsChanged, reloadNovel }: TabProps) {
  const [modelRoles, setModelRoles] = useState(novel.modelRoles ?? {});
  const [proseProfile, setProseProfile] = useState(novel.proseProfile ?? {});
  const [form, setForm] = useState({
    title: novel.title,
    premise: novel.premise,
    styleNotes: novel.styleNotes,
    defaultModel: novel.defaultModel,
    chapterLength: novel.chapterLength ? String(novel.chapterLength) : '',
  });
  const action = useAction();
  const [saved, setSaved] = useState(false);

  const save = () =>
    action.run(async () => {
      await updateNovel({
        modelRoles, proseProfile,
        title: form.title,
        premise: form.premise,
        styleNotes: form.styleNotes,
        defaultModel: form.defaultModel,
        chapterLength: form.chapterLength ? Number(form.chapterLength) : 0,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });

  const mode = <K extends keyof Novel>(key: K, value: Novel[K]) => action.run(() => updateNovel({ [key]: value } as Partial<Novel>));

  return (
    <div className="stack narrow-col">
      <div className="card">
        <h3>The novel</h3>
        <HarnessSettings roles={modelRoles} onRoles={setModelRoles} prose={proseProfile} onProse={setProseProfile} />
        <Field label="Title">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Premise">
          <textarea rows={5} value={form.premise} onChange={(e) => setForm({ ...form, premise: e.target.value })} />
        </Field>
        <Field label="Style notes">
          <textarea rows={3} value={form.styleNotes} onChange={(e) => setForm({ ...form, styleNotes: e.target.value })} />
        </Field>
        <div className="grid2">
          <Field label="Default model" hint={settings.getModel() ? `Global default: ${settings.getModel()}` : undefined}>
            <input className="mono" value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })} />
          </Field>
          <Field label="Words per chapter" hint="0 or blank: model decides">
            <input type="number" value={form.chapterLength} onChange={(e) => setForm({ ...form, chapterLength: e.target.value })} />
          </Field>
        </div>
        <p className="dim small">Style: {novel.style} (fixed at creation)</p>
        <div className="row">
          <button onClick={save} disabled={action.busy}>
            Save
          </button>
          {saved && <span className="ok">Saved.</span>}
        </div>
      </div>

      <div className="card">
        <h3>Agents</h3>
        <div className="grid2">
          <Field label="Story bible">
            <select value={novel.bibleMode ?? 'accept'} onChange={(e) => mode('bibleMode', e.target.value as Novel['bibleMode'])}>
              <option value="accept">update on accept</option>
              <option value="batch">batch catch-up</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Next-chapter suggestions">
            <select value={novel.suggestMode ?? 'on'} onChange={(e) => mode('suggestMode', e.target.value as Novel['suggestMode'])}>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Character designs">
            <select value={novel.designMode ?? 'off'} onChange={(e) => mode('designMode', e.target.value as Novel['designMode'])}>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Arc planning">
            <select value={novel.arcMode ?? 'off'} onChange={(e) => mode('arcMode', e.target.value as Novel['arcMode'])}>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Atlas">
            <select value={novel.mapMode ?? 'off'} onChange={(e) => mode('mapMode', e.target.value as Novel['mapMode'])}>
              <option value="accept">extract on accept</option>
              <option value="manual">manual</option>
              <option value="off">off</option>
            </select>
          </Field>
          <Field label="Name generation">
            <select value={novel.namingMode ?? 'off'} onChange={(e) => mode('namingMode', e.target.value as Novel['namingMode'])}>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
          </Field>
        </div>
      </div>

      <Cover novel={novel} base={base} onChanged={async () => { await reloadNovel(); onNovelsChanged(); }} />

      <div className="card">
        <h3>Privacy &amp; data</h3>
        <label className="check">
          <input type="checkbox" checked={novel.hidden} onChange={(e) => mode('hidden', e.target.checked)} /> Hidden in the vault
          <span className="dim small"> (needs the vault unlocked)</span>
        </label>
        <div className="row">
          <button
            className="ghost"
            onClick={() => action.run(async () => downloadJson(`${novel.title.replace(/[^\w-]+/g, '_')}.json`, await get(`${base}/export`)))}
          >
            Export this novel
          </button>
          <span className="grow" />
          <button
            className="danger"
            onClick={() =>
              action.run(async () => {
                if (!confirm(`Delete “${novel.title}” and everything in it? This cannot be undone.`)) return;
                await del(base);
                onNovelsChanged();
                go(null);
              })
            }
          >
            Delete novel
          </button>
        </div>
      </div>
      <ErrorLine text={action.error} />
    </div>
  );
}

/** Downscale an uploaded image to cover size and re-encode, keeping under the server's cap. */
async function toCoverDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image.'));
      el.src = url;
    });
    const scale = Math.min(1, 800 / img.width, 1200 / img.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function Cover({ novel, base, onChanged }: { novel: Novel; base: string; onChanged: () => Promise<void> }) {
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<'standard' | 'best'>('standard');
  const [cost, setCost] = useState<number | null>(null);
  const action = useAction();

  const generate = () =>
    action.run(async () => {
      const r = await post<{ coverUrl: string; cost?: number }>(`${base}/cover/generate`, { prompt, quality });
      setCost(r.cost ?? null);
      await onChanged();
    });

  const upload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void action.run(async () => {
      await post(`${base}/cover`, { image: await toCoverDataUrl(file) });
      await onChanged();
    });
  };

  return (
    <div className="card cover-card">
      <h3>Cover</h3>
      <div className="row top">
        <div className="cover">
          {novel.coverUrl ? <img src={novel.coverUrl} alt="cover" /> : <span className="spine-letter big">{novel.title.slice(0, 1)}</span>}
        </div>
        <div className="grow stack">
          <textarea rows={3} placeholder="Optional art direction for the generator" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div className="row">
            <select value={quality} onChange={(e) => setQuality(e.target.value as 'standard' | 'best')}>
              <option value="standard">standard</option>
              <option value="best">best</option>
            </select>
            <button onClick={generate} disabled={action.busy}>
              {action.busy ? 'Working…' : 'Generate cover'}
            </button>
          </div>
          {cost != null && <span className="usage">${cost.toFixed(4)}</span>}
          <label className="file">
            Upload image <input type="file" accept="image/png,image/jpeg,image/webp" onChange={upload} />
          </label>
          {novel.coverUrl && (
            <button className="ghost" onClick={() => action.run(async () => { await del(`${base}/cover`); await onChanged(); })}>
              Remove cover
            </button>
          )}
          <p className="dim small">Generation always needs your own OpenRouter key from Settings.</p>
        </div>
      </div>
      <ErrorLine text={action.error} />
    </div>
  );
}
