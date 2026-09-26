import { useEffect, useRef, useState } from 'react';
import { del, get, patch, post, settings } from '../lib/api';
import type { Chapter, ChapterMeta, ChapterSuggestion, Blueprint, Usage } from '../lib/types';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { ErrorLine, Field, StreamPanel, UsageLine, useAction, useLoad } from '../components/common';

type Selection = number | 'new';

export function WriteTab(props: TabProps) {
  const { base, novel } = props;
  const chapters = useLoad(() => get<ChapterMeta[]>(`${base}/chapters`), [base]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [model, setModel] = useState(novel.defaultModel || settings.getModel());

  const list = chapters.data ?? [];
  const next = list.reduce((m, c) => Math.max(m, c.number), 0) + 1;
  const current: Selection = selected ?? (list.length ? list[list.length - 1].number : 'new');

  const refresh = async (select?: Selection) => {
    await chapters.reload();
    await props.reloadNovel();
    props.onNovelsChanged();
    if (select !== undefined) setSelected(select);
  };

  return (
    <div className="split">
      <aside className="sublist">
        <Field label="Model for this session">
          <input className="mono small" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" />
        </Field>
        <ErrorLine text={chapters.error} />
        <ul className="chapters">
          {list.map((c) => (
            <li key={c.number}>
              <button className={current === c.number ? 'on' : ''} onClick={() => setSelected(c.number)}>
                <span className="num">{c.number}</span>
                <span className="grow ellipsis">{c.title || 'Untitled'}</span>
                <span className={`badge ${c.status}`}>{c.status === 'accepted' ? '✓' : 'draft'}</span>
              </button>
            </li>
          ))}
          <li>
            <button className={current === 'new' ? 'on' : ''} onClick={() => setSelected('new')}>
              <span className="num">+</span>
              <span className="grow">Chapter {next}</span>
            </button>
          </li>
        </ul>
      </aside>
      <div className="pane">
        {current === 'new' ? (
          <Composer key={`new-${next}`} {...props} n={next} model={model} onWritten={(n) => refresh(n)} />
        ) : (
          <ChapterView
            key={current}
            {...props}
            n={current}
            model={model}
            onChanged={() => refresh()}
            onDeleted={() => refresh('new')}
            onAccepted={() => refresh()}
          />
        )}
      </div>
    </div>
  );
}

// ── Composer: write a new chapter ────────────────────────────────────────

function Composer({ base, novel, n, model, onWritten }: TabProps & { n: number; model: string; onWritten: (n: number) => void }) {
  const [prompt, setPrompt] = useState('');
  const stream = useStream();
  const suggestions = useLoad(
    () => get<{ suggestions: ChapterSuggestion[]; fromChapter: number }>(`${base}/chapters/${n}/suggestions`),
    [base, n]
  );
  const plan = useLoad(() => get<{ blueprint: Blueprint | null; arcTitle: string | null }>(`${base}/arcs/blueprint/${n}`), [base, n]);
  const propose = useAction();
  const [proposalUsage, setProposalUsage] = useState<Usage | null>(null);

  const fresh = async () => {
    const r = await propose.run(() =>
      post<{ suggestions: ChapterSuggestion[]; usage: Usage }>(`${base}/chapters/${n}/suggestions`, {})
    );
    if (r) {
      suggestions.setData({ suggestions: r.suggestions, fromChapter: n - 1 });
      setProposalUsage(r.usage);
    }
  };

  const generate = async () => {
    const done = await stream.run(`${base}/chapters/${n}/generate`, { prompt, model: model || undefined });
    if (done) onWritten(n);
  };

  const bp = plan.data?.blueprint;
  const cards = suggestions.data?.suggestions ?? [];

  return (
    <div className="composer">
      <h2>Chapter {n}</h2>
      {bp && (
        <div className="card plan">
          <div className="row">
            <strong>Planned in “{plan.data?.arcTitle}”: {bp.title}</strong>
            <span className="grow" />
            <button className="ghost" onClick={() => setPrompt(bp.summary)}>
              Use plan
            </button>
          </div>
          <p className="small">{bp.summary}</p>
          {(bp.tags ?? []).length > 0 && <p className="dim small">{(bp.tags ?? []).join(' · ')}</p>}
        </div>
      )}
      {n > 1 && novel.suggestMode !== 'off' && (
        <div className="suggestions">
          <div className="row">
            <span className="dim small">Directions</span>
            <span className="grow" />
            <button className="ghost" onClick={fresh} disabled={propose.busy}>
              {propose.busy ? 'Thinking…' : cards.length ? 'Propose fresh' : 'Propose directions'}
            </button>
          </div>
          <UsageLine usage={proposalUsage} />
          <ErrorLine text={propose.error} />
          <div className="cards">
            {cards.map((s, i) => (
              <button key={i} className="card suggestion" onClick={() => setPrompt(s.prompt)} title={s.rationale}>
                <span className="move">{s.move}</span>
                <strong>{s.title}</strong>
                <span className="small">{s.prompt}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <Field label="What happens in this chapter?">
        <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Direction for the writer…" />
      </Field>
      <div className="row">
        <button onClick={generate} disabled={!prompt.trim() || stream.running}>
          {stream.running ? 'Writing…' : 'Write chapter'}
        </button>
        {!model && <span className="dim small">No model set — the novel's default is used.</span>}
      </div>
      <StreamPanel stream={stream} title="generate" />
    </div>
  );
}

// ── A written chapter ────────────────────────────────────────────────────

interface Defect {
  kind: string;
  observed: unknown;
  band: unknown;
}

function ChapterView({
  base,
  n,
  model,
  onChanged,
  onDeleted,
  onAccepted,
}: TabProps & { n: number; model: string; onChanged: () => void; onDeleted: () => void; onAccepted: () => void }) {
  const chapter = useLoad(() => get<Chapter>(`${base}/chapters/${n}`), [base, n]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [notes, setNotes] = useState('');
  const [defects, setDefects] = useState<Defect[] | null>(null);
  const [inline, setInline] = useState({ action: 'rewrite', instruction: '' });
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [replacement, setReplacement] = useState<{ replacement: string; start: number; end: number; warning?: string } | null>(null);
  const [saveUsage, setSaveUsage] = useState<Usage | null>(null);
  const stream = useStream();
  const action = useAction();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [streamKind, setStreamKind] = useState('');

  const ch = chapter.data;
  useEffect(() => {
    if (ch) {
      setTitle(ch.title);
      setContent(ch.content);
    }
  }, [ch]);

  if (chapter.error) return <ErrorLine text={chapter.error} />;
  if (!ch) return <p className="dim">Loading…</p>;

  const dirty = title !== ch.title || content !== ch.content;
  const isDraft = ch.status === 'draft';
  const m = model || undefined;

  const save = (origin?: 'inline' | 'restore', override?: { title: string; content: string }) =>
    action.run(async () => {
      const body = override ?? { title, content };
      const r = await patch<{ chapter: Chapter; usage: Usage | null }>(`${base}/chapters/${n}`, { ...body, origin });
      chapter.setData(r.chapter);
      setSaveUsage(r.usage);
      onChanged();
    });

  const runStream = async (kind: string, path: string, body: unknown) => {
    setStreamKind(kind);
    const done = await stream.run(path, body);
    return done;
  };

  const revise = async () => {
    const done = await runStream('revise', `${base}/chapters/${n}/revise`, { notes, model: m });
    if (done) {
      setNotes('');
      chapter.setData(done as Chapter);
      onChanged();
    }
  };

  const humanize = async () => {
    const done = (await runStream('humanize', `${base}/chapters/${n}/humanize`, { model: m })) as
      | { chapter: Chapter; resolved: string[]; remaining: string[] }
      | null;
    if (done) {
      chapter.setData(done.chapter);
      setDefects(null);
      onChanged();
    }
  };

  const accept = async () => {
    const done = await runStream('accept', `${base}/chapters/${n}/accept`, { model: m });
    if (done) {
      await chapter.reload();
      onAccepted();
    }
  };

  const captureSelection = () => {
    const el = textRef.current;
    if (!el) return;
    if (el.selectionEnd > el.selectionStart) setSelection({ start: el.selectionStart, end: el.selectionEnd });
  };

  const runInline = async () => {
    if (!selection) return;
    if (dirty) {
      action.setError('Save your hand edits before an inline edit — offsets are measured against the saved text.');
      return;
    }
    setReplacement(null);
    const done = (await runStream('inline edit', `${base}/chapters/${n}/edit`, {
      action: inline.action,
      start: selection.start,
      end: selection.end,
      text: content.slice(selection.start, selection.end),
      instruction: inline.instruction,
      model: m,
    })) as { replacement: string; start: number; end: number; warning?: string } | null;
    if (done) setReplacement(done);
  };

  const applyInline = async () => {
    if (!replacement) return;
    const next = content.slice(0, replacement.start) + replacement.replacement + content.slice(replacement.end);
    setContent(next);
    await save('inline', { title, content: next });
    setReplacement(null);
    setSelection(null);
  };

  const preview = () =>
    action.run(async () => {
      const r = await get<{ defects: Defect[]; words: number }>(`${base}/chapters/${n}/humanize/preview`);
      setDefects(r.defects);
    });

  const remove = () =>
    action.run(async () => {
      if (!confirm(`Delete chapter ${n}? Later chapters are renumbered.`)) return;
      await del(`${base}/chapters/${n}`);
      onDeleted();
    });

  const words = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="chapter">
      <div className="row">
        <input className="title-input grow" value={title} onChange={(e) => setTitle(e.target.value)} />
        <span className={`badge ${ch.status}`}>{ch.status}</span>
        <span className="dim small">{words.toLocaleString()} words</span>
      </div>
      <div className="dim small">
        Model: {ch.model || '—'} · Prompt: <em>{ch.userPrompt || '—'}</em>
      </div>

      {stream.running && (streamKind === 'revise' || streamKind === 'humanize') ? (
        <StreamPanel stream={stream} title={streamKind} />
      ) : (
        <textarea
          ref={textRef}
          className="manuscript"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onSelect={captureSelection}
          rows={24}
        />
      )}

      <div className="row">
        <button onClick={() => save()} disabled={!dirty || action.busy}>
          Save edits
        </button>
        {dirty && (
          <button className="ghost" onClick={() => { setTitle(ch.title); setContent(ch.content); }}>
            Discard
          </button>
        )}
        <span className="grow" />
        {isDraft && (
          <button className="accent" onClick={accept} disabled={stream.running || dirty}>
            Accept chapter
          </button>
        )}
        <button className="danger ghost" onClick={remove}>
          Delete
        </button>
      </div>
      <UsageLine usage={saveUsage} />
      <ErrorLine text={action.error} />
      {!(stream.running && (streamKind === 'revise' || streamKind === 'humanize')) && <StreamPanel stream={stream} title={streamKind} showText={streamKind === 'inline edit'} />}

      <div className="tools">
        <details className="card">
          <summary>Inline edit {selection ? `(${selection.end - selection.start} chars selected)` : '(select text above)'}</summary>
          <div className="row">
            <select value={inline.action} onChange={(e) => setInline({ ...inline, action: e.target.value })}>
              {['rewrite', 'expand', 'shorten', 'describe', 'custom'].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <input
              className="grow"
              placeholder={inline.action === 'custom' ? 'Instruction (required)' : 'Extra instruction (optional)'}
              value={inline.instruction}
              onChange={(e) => setInline({ ...inline, instruction: e.target.value })}
            />
            <button onClick={runInline} disabled={!selection || stream.running}>
              Run
            </button>
          </div>
          {selection && <blockquote className="small">{content.slice(selection.start, selection.end).slice(0, 400)}</blockquote>}
          {replacement && (
            <div className="card">
              {replacement.warning && <div className="warn">{replacement.warning}</div>}
              <pre className="prose">{replacement.replacement}</pre>
              <div className="row">
                <button onClick={applyInline}>Apply</button>
                <button className="ghost" onClick={() => setReplacement(null)}>
                  Discard
                </button>
              </div>
            </div>
          )}
        </details>

        {isDraft && (
          <details className="card">
            <summary>Revise</summary>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What should change?" />
            <button onClick={revise} disabled={!notes.trim() || stream.running}>
              Revise draft
            </button>
            {ch.revisionNotes.length > 0 && (
              <ul className="small dim">
                {ch.revisionNotes.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </details>
        )}

        {isDraft && (
          <details className="card">
            <summary>Humanize</summary>
            <div className="row">
              <button className="ghost" onClick={preview}>
                Check defects (free)
              </button>
              <button onClick={humanize} disabled={stream.running}>
                Humanize
              </button>
            </div>
            {defects && (defects.length === 0 ? <p className="small">Nothing to repair.</p> : (
              <ul className="small">
                {defects.map((d, i) => (
                  <li key={i}>
                    <strong>{d.kind}</strong> — observed {JSON.stringify(d.observed)}
                    {d.band ? `, target ${JSON.stringify(d.band)}` : ''}
                  </li>
                ))}
              </ul>
            ))}
          </details>
        )}

        {ch.summary && (
          <details className="card">
            <summary>Summary</summary>
            <p className="small">{ch.summary}</p>
          </details>
        )}

        {ch.nextSuggestions && ch.nextSuggestions.length > 0 && (
          <details className="card">
            <summary>Directions for chapter {n + 1}</summary>
            <ul className="small">
              {ch.nextSuggestions.map((s, i) => (
                <li key={i}>
                  <strong>{s.move}: {s.title}</strong> — {s.prompt}
                </li>
              ))}
            </ul>
          </details>
        )}

        {ch.versions && ch.versions.length > 0 && (
          <details className="card">
            <summary>History ({ch.versions.length})</summary>
            <ul className="plain">
              {[...ch.versions].reverse().map((v, i) => (
                <li key={i} className="row">
                  <span className="small">
                    before <strong>{v.kind}</strong> · {new Date(v.at).toLocaleString()} {v.note ? `— ${v.note}` : ''}
                  </span>
                  <span className="grow" />
                  <button className="ghost" onClick={() => save('restore', { title: v.title, content: v.content })}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
