import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal .env loader for local dev. Production (Cloud Run) sets real
 * environment variables and never has a .env file, so this is a no-op there.
 * The repo keeps one .env at its root (the live tests already read it), and
 * `npm run dev` runs from backend/, so both locations are tried. Real
 * environment always wins — a set variable is never overwritten.
 */
export function loadDotEnv(): void {
  for (const candidate of ['.env', '../.env']) {
    const path = resolve(process.cwd(), candidate);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*["']?([^"'\n]*?)["']?\s*$/);
      if (!match) continue;
      const [, name, value] = match;
      if (process.env[name] === undefined && value) process.env[name] = value;
    }
    return;
  }
}
