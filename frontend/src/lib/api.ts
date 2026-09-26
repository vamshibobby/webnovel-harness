/*
 * The one place the UI talks to the local server. Every request carries the
 * OpenRouter key (when set) and the vault token (when unlocked). SSE is read
 * from POST bodies with fetch + ReadableStream, since EventSource is GET-only.
 */

const KEY_STORAGE = 'nh.openrouterKey';
const MODEL_STORAGE = 'nh.defaultModel';
const VAULT_STORAGE = 'nh.vaultToken';

function readLocal(key: string, store: Storage = localStorage): string {
  try {
    return store.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeLocal(key: string, value: string, store: Storage = localStorage): void {
  try {
    if (value) store.setItem(key, value);
    else store.removeItem(key);
  } catch {
    /* storage unavailable: settings last for this page only */
  }
}

export const settings = {
  getKey: () => readLocal(KEY_STORAGE),
  setKey: (v: string) => writeLocal(KEY_STORAGE, v.trim()),
  getModel: () => readLocal(MODEL_STORAGE),
  setModel: (v: string) => writeLocal(MODEL_STORAGE, v.trim()),
  getVaultToken: () => readLocal(VAULT_STORAGE, sessionStorage),
  setVaultToken: (v: string) => writeLocal(VAULT_STORAGE, v, sessionStorage),
};

/** Fired when the server says there is no usable OpenRouter key. */
export const NO_KEY_EVENT = 'nh:no-key';

function looksLikeNoKey(status: number, message: string): boolean {
  return status === 400 && /openrouter key|x-openrouter-key|reach a model|api key/i.test(message);
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const key = settings.getKey();
  if (key) h['X-OpenRouter-Key'] = key;
  const vault = settings.getVaultToken();
  if (vault) h['X-Vault-Token'] = vault;
  return h;
}

async function failFrom(res: Response): Promise<never> {
  let body: unknown = null;
  let message = `${res.status} ${res.statusText}`;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    /* not JSON */
  }
  if (looksLikeNoKey(res.status, message)) window.dispatchEvent(new CustomEvent(NO_KEY_EVENT));
  throw new ApiError(res.status, message, body);
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'),
    headers: headers(hasBody),
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!res.ok) return failFrom(res);
  return (await res.json()) as T;
}

export const get = <T = unknown>(path: string) => api<T>(path);
export const post = <T = unknown>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body });
export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body });
export const del = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'DELETE', body });

/**
 * POST and read the response as Server-Sent Events. The server may also answer
 * with a plain JSON error before the stream starts; that throws an ApiError.
 */
export async function streamPost(
  path: string,
  body: unknown,
  onEvent: (event: string, data: unknown) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) return failFrom(res);
  if (!res.body) throw new Error('The server returned no stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];

  const dispatch = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* leave as text */
    }
    onEvent(eventName, data);
    eventName = 'message';
    dataLines = [];
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  dispatch();
}

/** Save any JSON value as a download. */
export function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
