import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { del, get, patch } from '../lib/api';
import { useStream } from '../lib/useStream';
import type { TabProps } from '../components/Workspace';
import { Empty, ErrorLine, ModeOff, StreamPanel, useAction, useLoad } from '../components/common';

interface GeoEntity {
  id: string;
  kind: string;
  name: string;
  aliases: string[];
  importance: number;
  firstChapter: number;
  pin?: { x: number; y: number };
}

interface MapDoc {
  title: string;
  entities: Record<string, GeoEntity>;
  facts: unknown[];
}

interface MapState {
  map: MapDoc | null;
  svg: string | null;
  mapMode: 'off' | 'manual' | 'accept';
  mapChapter: number;
}

export function AtlasTab({ base, novel, updateNovel }: TabProps) {
  // The server renders the atlas to SVG itself; `theme=dark` resolves its colour tokens for our dark desk.
  const atlas = useLoad(() => get<MapState>(`${base}/maps?theme=dark`), [base]);
  const stream = useStream();
  const action = useAction();
  const [text, setText] = useState('');

  if (atlas.data && atlas.data.mapMode === 'off') {
    return (
      <ModeOff
        feature="The Atlas"
        onEnable={async () => {
          await updateNovel({ mapMode: 'manual' });
          await atlas.reload();
        }}
      />
    );
  }

  const data = atlas.data;
  const entities = data?.map ? Object.values(data.map.entities) : [];

  const catchUp = async () => {
    await stream.run(`${base}/maps/update`, {});
    await atlas.reload();
  };
  const dictate = async () => {
    const done = await stream.run(`${base}/maps/dictate`, { text });
    if (done) setText('');
    await atlas.reload();
  };

  return (
    <div className="atlas">
      <div className="atlas-map">
        <ErrorLine text={atlas.error} />
        {data?.svg ? (
          <div className="svg-host" dangerouslySetInnerHTML={{ __html: data.svg }} />
        ) : (
          <Empty>No map yet. Describe some geography, sketch it, or catch up from accepted chapters.</Empty>
        )}
      </div>
      <aside className="atlas-side">
        <div className="card compact">
          <div className="row small">
            <span>Mode:</span>
            <select value={data?.mapMode ?? 'manual'} onChange={async (e) => { await updateNovel({ mapMode: e.target.value as MapState['mapMode'] }); await atlas.reload(); }}>
              <option value="manual">manual</option>
              <option value="accept">extract on accept</option>
              <option value="off">off</option>
            </select>
          </div>
          <div className="dim small">Mapped through chapter {data?.mapChapter ?? 0} of {novel.chapterCount}.</div>
          <button className="ghost" onClick={catchUp} disabled={stream.running}>
            Catch up from chapters
          </button>
        </div>
        <div className="card compact">
          <textarea rows={4} placeholder="Dictate geography: “The capital sits where two rivers meet…”" value={text} onChange={(e) => setText(e.target.value)} />
          <button onClick={dictate} disabled={!text.trim() || stream.running}>
            Dictate
          </button>
        </div>
        <Sketch base={base} disabled={stream.running} run={stream.run} onDone={atlas.reload} />
        <StreamPanel stream={stream} showText={false} />
        <h3>Places ({entities.length})</h3>
        <ul className="plain places">
          {entities.map((e) => (
            <Place key={e.id} base={base} entity={e} onChanged={atlas.reload} />
          ))}
        </ul>
        {data?.map && (
          <button
            className="danger ghost"
            onClick={() => action.run(async () => { if (confirm('Erase the whole map?')) { await del(`${base}/maps`); await atlas.reload(); } })}
          >
            Reset map
          </button>
        )}
        <ErrorLine text={action.error} />
      </aside>
    </div>
  );
}

function Place({ base, entity, onChanged }: { base: string; entity: GeoEntity; onChanged: () => void }) {
  const [name, setName] = useState(entity.name);
  const [x, setX] = useState(entity.pin ? String(entity.pin.x) : '');
  const [y, setY] = useState(entity.pin ? String(entity.pin.y) : '');
  const action = useAction();
  const save = () =>
    action.run(async () => {
      const body: Record<string, unknown> = {};
      if (name !== entity.name) body.name = name;
      if (x !== '' && y !== '') body.pin = { x: Number(x), y: Number(y) };
      await patch(`${base}/maps/entities/${encodeURIComponent(entity.id)}`, body);
      onChanged();
    });
  return (
    <li>
      <div className="row small">
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <span className="tag">{entity.kind}</span>
      </div>
      <div className="row small">
        <span className="dim">pin</span>
        <input className="narrow" placeholder="x" value={x} onChange={(e) => setX(e.target.value)} />
        <input className="narrow" placeholder="y" value={y} onChange={(e) => setY(e.target.value)} />
        <button className="ghost tiny" onClick={save} disabled={action.busy}>
          save
        </button>
      </div>
      <ErrorLine text={action.error} />
    </li>
  );
}

// ── Sketch: click to drop labelled shapes, send PNG + shape list ─────────

interface Shape {
  kind: 'region' | 'settlement' | 'water';
  label: string;
  x: number;
  y: number;
}

const SIZE = 360;
const COLORS: Record<Shape['kind'], string> = { region: '#c89b5a', settlement: '#e8dcc4', water: '#5a8fc8' };

function Sketch({
  base,
  disabled,
  run,
  onDone,
}: {
  base: string;
  disabled: boolean;
  run: (path: string, body: unknown) => Promise<unknown>;
  onDone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [kind, setKind] = useState<Shape['kind']>('settlement');

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#f4efe4';
    ctx.fillRect(0, 0, SIZE, SIZE);
    for (const s of shapes) {
      ctx.fillStyle = COLORS[s.kind];
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      const r = s.kind === 'settlement' ? 6 : 30;
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#222';
      ctx.font = '12px sans-serif';
      ctx.fillText(s.label, s.x + 8, s.y - 8);
    }
  }, [shapes]);

  const click = (e: MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const label = prompt(`Label for this ${kind}?`);
    if (!label) return;
    setShapes((s) => [...s, { kind, label, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
  };

  const send = async () => {
    const image = canvas.current?.toDataURL('image/png') ?? '';
    const scale = 1000 / SIZE;
    await run(`${base}/maps/sketch`, {
      image,
      shapes: shapes.map((s) => ({
        kind: s.kind,
        label: s.label,
        x: Math.round(s.x * scale),
        y: Math.round(s.y * scale),
        ...(s.kind === 'settlement' ? {} : { area: 0.05 }),
      })),
    });
    onDone();
  };

  return (
    <details className="card compact">
      <summary>Sketch</summary>
      <div className="row small">
        {(['settlement', 'region', 'water'] as const).map((k) => (
          <label key={k} className="check">
            <input type="radio" checked={kind === k} onChange={() => setKind(k)} /> {k}
          </label>
        ))}
      </div>
      <canvas ref={canvas} width={SIZE} height={SIZE} className="sketch" onClick={click} />
      <div className="row">
        <button onClick={send} disabled={disabled || shapes.length === 0}>
          Send sketch
        </button>
        <button className="ghost" onClick={() => setShapes([])}>
          Clear
        </button>
      </div>
      <p className="dim small">Click to drop a labelled shape. Uses your own OpenRouter key (vision model).</p>
    </details>
  );
}
