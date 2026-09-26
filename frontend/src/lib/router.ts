import { useEffect, useState } from 'react';

/*
 * A hash router in a dozen lines. Routes:
 *   #/                      — the desk (no novel open)
 *   #/n/<novelId>/<tab>     — a novel's workspace
 */

export const TABS = ['write', 'bible', 'characters', 'arcs', 'names', 'atlas', 'power', 'settings'] as const;
export type Tab = (typeof TABS)[number];

export interface Route {
  novelId: string | null;
  tab: Tab;
}

function parse(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'n' && parts[1]) {
    const tab = (TABS as readonly string[]).includes(parts[2] ?? '') ? (parts[2] as Tab) : 'write';
    return { novelId: decodeURIComponent(parts[1]), tab };
  }
  return { novelId: null, tab: 'write' };
}

export function go(novelId: string | null, tab: Tab = 'write'): void {
  window.location.hash = novelId ? `#/n/${encodeURIComponent(novelId)}/${tab}` : '#/';
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
