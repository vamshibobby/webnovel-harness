import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { errorText } from '../lib/api';
import type { Usage } from '../lib/types';
import type { Stream } from '../lib/useStream';

/** Load something once (and again on `reload`), tracking error and busy. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await load());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, setData, error, loading, reload };
}

/** Wrap a one-shot action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (err) {
      setError(errorText(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function ErrorLine({ text }: { text: string }) {
  if (!text) return null;
  return <div className="err">{text}</div>;
}

export function UsageLine({ usage, calls }: { usage: Usage | null | undefined; calls?: number }) {
  if (!usage) return null;
  return (
    <div className="usage">
      <span>${usage.cost.toFixed(4)}</span>
      <span>{usage.promptTokens.toLocaleString()} in</span>
      <span>{usage.completionTokens.toLocaleString()} out</span>
      {usage.cachedTokens > 0 && <span>{usage.cachedTokens.toLocaleString()} cached</span>}
      {usage.cacheWriteTokens > 0 && <span>{usage.cacheWriteTokens.toLocaleString()} cache-write</span>}
      {calls && calls > 1 ? <span>{calls} calls</span> : null}
    </div>
  );
}

/** The live view of an agent call: streamed text, trace lines, cost. */
export function StreamPanel({ stream, showText = true, title }: { stream: Stream; showText?: boolean; title?: string }) {
  const idle = !stream.running && !stream.text && stream.log.length === 0 && !stream.error;
  if (idle) return null;
  return (
    <div className="stream">
      <div className="stream-head">
        <span className={stream.running ? 'pulse' : ''}>{stream.running ? '● running' : '○ finished'}</span>
        {title && <span className="dim">{title}</span>}
        <span className="grow" />
        {stream.running ? (
          <button className="ghost" onClick={stream.stop}>
            Stop
          </button>
        ) : (
          <button className="ghost" onClick={stream.reset}>
            Clear
          </button>
        )}
      </div>
      <UsageLine usage={stream.usage} calls={stream.calls} />
      {stream.warning && <div className="warn">{stream.warning}</div>}
      <ErrorLine text={stream.error} />
      {stream.log.length > 0 && (
        <details open={stream.running}>
          <summary>Trace ({stream.log.length})</summary>
          <ol className="trace">
            {stream.log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </details>
      )}
      {stream.reasoning && (
        <details>
          <summary>Reasoning</summary>
          <pre className="reasoning">{stream.reasoning}</pre>
        </details>
      )}
      {showText && stream.text && <pre className="prose live">{stream.text}</pre>}
    </div>
  );
}

/**
 * Edit an object as JSON. The lightweight answer to deeply nested shapes
 * (designs, power systems, charters): the server validates, we show its word.
 */
export function JsonEditor({
  value,
  onSave,
  rows = 16,
  label = 'Save',
}: {
  value: unknown;
  onSave: (next: unknown) => Promise<unknown>;
  rows?: number;
  label?: string;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [parseError, setParseError] = useState('');
  const action = useAction();
  // Keyed on the serialized value, so a parent re-render with an equal object
  // does not throw away what is being typed.
  useEffect(() => {
    setText(serialized);
  }, [serialized]);
  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      setParseError('');
    } catch (err) {
      setParseError(`Not valid JSON: ${errorText(err)}`);
      return;
    }
    await action.run(() => onSave(parsed));
  };
  return (
    <div className="json-editor">
      <textarea className="mono" rows={rows} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="row">
        <button onClick={save} disabled={action.busy}>
          {action.busy ? 'Saving…' : label}
        </button>
        <ErrorLine text={parseError || action.error} />
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Shown when a feature's mode is off, with a one-click way to turn it on. */
export function ModeOff({ feature, onEnable }: { feature: string; onEnable: () => Promise<unknown> }) {
  const action = useAction();
  return (
    <div className="card mode-off">
      <p>{feature} is turned off for this novel.</p>
      <button onClick={() => action.run(onEnable)} disabled={action.busy}>
        Turn it on
      </button>
      <ErrorLine text={action.error} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="mono small">{JSON.stringify(value, null, 2)}</pre>;
}
