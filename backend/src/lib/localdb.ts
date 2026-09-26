import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The whole database: a folder of JSON files.
 *
 *   data/
 *     novels/<novelId>/novel.json
 *     novels/<novelId>/<collection>/<docId>.json   (chapters, bible, designs, arcs, maps, naming, power)
 *     users/<uid>.json                              (vault profile)
 *     covers/<file>                                 (cover images, served at /files/covers/)
 *
 * Every call is synchronous on purpose. The server is one process, and the
 * store's read-merge-write "transactions" take synchronous merge callbacks, so
 * a synchronous read → merge → write can never interleave with another request.
 * That is the same guarantee a database transaction gives, with nothing to
 * install.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * leaves the previous version rather than half a JSON document.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** `DATA_DIR` if set, else `<repo>/data` (same depth from src/lib and dist/lib). */
export const DATA_DIR = resolve(process.env.DATA_DIR || join(here, '..', '..', '..', 'data'));

/**
 * Ids arrive from URLs. Anything outside this alphabet could walk the path
 * (`../`), so it is refused before it gets near the filesystem.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function assertSafeId(id: string): string {
  if (!isSafeId(id)) throw new Error(`unsafe id: ${JSON.stringify(id)}`);
  return id;
}

/** A 20-character random id. */
export function newId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (const b of randomBytes(20)) id += alphabet[b % alphabet.length];
  return id;
}

export function dataPath(...segments: string[]): string {
  return join(DATA_DIR, ...segments);
}

export function readDoc<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeDoc(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export function removeDoc(file: string): void {
  rmSync(file, { force: true });
}

export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Every `*.json` document directly inside `dir`, in no particular order. */
export function listDocs<T>(dir: string): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T);
}

/** Sub-directory names of `dir` (e.g. every novel id). */
export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Drop keys whose value is `undefined`. A patch like `{ title: undefined }`
 * means "leave title alone", not "delete title" — spreading it over the
 * existing document would erase the field.
 */
export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function writeBinary(file: string, data: Buffer): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}
