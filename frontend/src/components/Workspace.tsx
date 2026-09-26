import { get, patch } from '../lib/api';
import { TABS, go, type Tab } from '../lib/router';
import type { Novel } from '../lib/types';
import { ErrorLine, useLoad } from './common';
import { WriteTab } from '../tabs/WriteTab';
import { BibleTab } from '../tabs/BibleTab';
import { CharactersTab } from '../tabs/CharactersTab';
import { ArcsTab } from '../tabs/ArcsTab';
import { NamesTab } from '../tabs/NamesTab';
import { AtlasTab } from '../tabs/AtlasTab';
import { PowerTab } from '../tabs/PowerTab';
import { NovelSettingsTab } from '../tabs/NovelSettingsTab';

export interface TabProps {
  novel: Novel;
  /** Base path for this novel's API routes: /api/novels/<id> */
  base: string;
  reloadNovel: () => Promise<void>;
  /** PATCH the novel (modes, title…) and reload it. */
  updateNovel: (fields: Partial<Novel>) => Promise<void>;
  onNovelsChanged: () => void;
}

const LABELS: Record<Tab, string> = {
  write: 'Write',
  bible: 'Bible',
  characters: 'Characters',
  arcs: 'Arcs',
  names: 'Names',
  atlas: 'Atlas',
  power: 'Power',
  settings: 'Settings',
};

export function Workspace({ novelId, tab, onNovelsChanged }: { novelId: string; tab: Tab; onNovelsChanged: () => void }) {
  const base = `/api/novels/${encodeURIComponent(novelId)}`;
  const novel = useLoad(() => get<Novel>(base), [base]);

  if (novel.error && !novel.data) {
    return (
      <div className="pad">
        <ErrorLine text={novel.error} />
        <p className="dim">If this novel is hidden, unlock the vault first.</p>
      </div>
    );
  }
  if (!novel.data) return <div className="pad dim">Opening…</div>;

  const props: TabProps = {
    novel: novel.data,
    base,
    reloadNovel: novel.reload,
    updateNovel: async (fields) => {
      await patch(base, fields);
      await novel.reload();
      onNovelsChanged();
    },
    onNovelsChanged,
  };

  return (
    <div className="workspace">
      <header className="ws-head">
        <div>
          <h1>{novel.data.title}</h1>
          <span className="dim small">
            {novel.data.style} · {novel.data.chapterCount} chapters · {novel.data.wordCount.toLocaleString()} words
            {novel.data.defaultModel ? ` · ${novel.data.defaultModel}` : ''}
            {novel.data.hidden ? ' · hidden' : ''}
          </span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t} className={t === tab ? 'on' : ''} onClick={() => go(novelId, t)}>
              {LABELS[t]}
            </button>
          ))}
        </nav>
      </header>
      <section className="ws-body">
        {tab === 'write' && <WriteTab {...props} />}
        {tab === 'bible' && <BibleTab {...props} />}
        {tab === 'characters' && <CharactersTab {...props} />}
        {tab === 'arcs' && <ArcsTab {...props} />}
        {tab === 'names' && <NamesTab {...props} />}
        {tab === 'atlas' && <AtlasTab {...props} />}
        {tab === 'power' && <PowerTab {...props} />}
        {tab === 'settings' && <NovelSettingsTab {...props} />}
      </section>
    </div>
  );
}
