import { useCallback, useRef, useState } from 'react';
import { errorText, streamPost } from './api';
import type { Usage } from './types';

/*
 * One running agent call. Collects streamed prose (`token`), reasoning, trace
 * lines, usage totals and warnings, and hands every event to an optional
 * handler for route-specific payloads (blueprint, cast, report, progress…).
 */

export interface StreamState {
  running: boolean;
  text: string;
  reasoning: string;
  log: string[];
  usage: Usage | null;
  calls: number;
  warning: string;
  error: string;
  result: unknown;
}

const empty: StreamState = {
  running: false,
  text: '',
  reasoning: '',
  log: [],
  usage: null,
  calls: 0,
  warning: '',
  error: '',
  result: null,
};

function addUsage(a: Usage | null, b: Partial<Usage>): Usage {
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b.completionTokens ?? 0),
    cachedTokens: (a?.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
    cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
    cost: (a?.cost ?? 0) + (b.cost ?? 0),
  };
}

function describe(event: string, data: unknown): string {
  if (typeof data === 'string') return data;
  if (event === 'progress' && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if ('chapter' in d) return `Chapter ${d.chapter}${d.title ? ` — ${d.title}` : ''} (${d.done}/${d.total})`;
    if ('from' in d) return `Planning chapters ${d.from}–${d.to}`;
  }
  const json = JSON.stringify(data);
  return json.length > 240 ? `${json.slice(0, 240)}…` : json;
}

export type StreamHandler = (event: string, data: unknown) => void;

export function useStream() {
  const [state, setState] = useState<StreamState>(empty);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (path: string, body: unknown, onEvent?: StreamHandler): Promise<unknown> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ ...empty, running: true });
      let final: unknown = null;
      try {
        await streamPost(
          path,
          body,
          (event, data) => {
            onEvent?.(event, data);
            if (event === 'done') final = data;
            setState((s) => {
              switch (event) {
                case 'token':
                  return { ...s, text: s.text + String(data) };
                case 'reasoning':
                  return { ...s, reasoning: s.reasoning + String(data) };
                case 'restart':
                  return { ...s, text: '', log: [...s.log, '↺ restarted'] };
                case 'usage':
                  return { ...s, usage: addUsage(s.usage, data as Partial<Usage>), calls: s.calls + 1 };
                case 'warning':
                  return { ...s, warning: String(data) };
                case 'error':
                  return { ...s, error: String(data) };
                case 'done':
                  return { ...s, result: data, log: [...s.log, '✓ done'] };
                case 'tool':
                  return { ...s, log: [...s.log, `tool: ${describe(event, data)}`] };
                default:
                  return { ...s, log: [...s.log, event === 'trace' ? describe(event, data) : `${event}: ${describe(event, data)}`] };
              }
            });
          },
          controller.signal
        );
      } catch (err) {
        if (!controller.signal.aborted) setState((s) => ({ ...s, error: errorText(err) }));
        else setState((s) => ({ ...s, log: [...s.log, '■ stopped'] }));
      } finally {
        setState((s) => ({ ...s, running: false }));
      }
      return final;
    },
    []
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => setState(empty), []);

  return { ...state, run, stop, reset };
}

export type Stream = ReturnType<typeof useStream>;
