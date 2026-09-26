import { useEffect, useState } from 'react';
import { NO_KEY_EVENT, get, settings } from './lib/api';
import { useRoute } from './lib/router';
import type { Novel } from './lib/types';
import { Rail } from './components/Rail';
import { SettingsModal } from './components/SettingsModal';
import { VaultPanel } from './components/VaultPanel';
import { Workspace } from './components/Workspace';
import { useLoad } from './components/common';

export function App() {
  const route = useRoute();
  const [showSettings, setShowSettings] = useState(false);
  const [showVault, setShowVault] = useState(false);
  const [noKey, setNoKey] = useState(false);
  const novels = useLoad(() => get<Novel[]>('/api/novels'), []);

  useEffect(() => {
    const onNoKey = () => setNoKey(true);
    window.addEventListener(NO_KEY_EVENT, onNoKey);
    return () => window.removeEventListener(NO_KEY_EVENT, onNoKey);
  }, []);

  return (
    <div className="app">
      <Rail
        novels={novels.data ?? []}
        error={novels.error}
        activeId={route.novelId}
        onChanged={novels.reload}
        onSettings={() => setShowSettings(true)}
        onVault={() => setShowVault(true)}
      />
      <main className="desk">
        {noKey && (
          <div className="banner">
            <span>
              The server has no OpenRouter key to use for this. Paste yours in{' '}
              <button className="link" onClick={() => setShowSettings(true)}>
                Settings
              </button>{' '}
              (or give the server its own key in its <code>.env</code>).
            </span>
            <button className="ghost" onClick={() => setNoKey(false)}>
              Dismiss
            </button>
          </div>
        )}
        {route.novelId ? (
          <Workspace key={route.novelId} novelId={route.novelId} tab={route.tab} onNovelsChanged={novels.reload} />
        ) : (
          <Welcome hasKey={!!settings.getKey()} count={novels.data?.length ?? 0} onSettings={() => setShowSettings(true)} />
        )}
      </main>
      {showSettings && (
        <SettingsModal
          onClose={() => {
            setShowSettings(false);
            if (settings.getKey()) setNoKey(false);
          }}
        />
      )}
      {showVault && <VaultPanel onClose={() => setShowVault(false)} onChanged={novels.reload} />}
    </div>
  );
}

function Welcome({ hasKey, count, onSettings }: { hasKey: boolean; count: number; onSettings: () => void }) {
  return (
    <div className="welcome">
      <h1>Novel Harness</h1>
      <p className="dim">A local writing desk for long serial fiction. Everything stays on this machine.</p>
      <ol>
        <li>
          {hasKey ? 'OpenRouter key saved.' : 'Add an OpenRouter key'} —{' '}
          <button className="link" onClick={onSettings}>
            Settings
          </button>
        </li>
        <li>{count > 0 ? `Pick one of your ${count} novels on the left.` : 'Start a novel from the left rail.'}</li>
        <li>Open the Write tab, give the first chapter a direction, and watch it stream in.</li>
      </ol>
    </div>
  );
}
