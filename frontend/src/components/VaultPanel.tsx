import { useState } from 'react';
import { del, get, post, settings } from '../lib/api';
import { go } from '../lib/router';
import type { Novel } from '../lib/types';
import { ErrorLine, Field, useAction, useLoad } from './common';
import { Modal } from './Modal';

interface VaultStatus {
  pinSet: boolean;
  unlocked: boolean;
}

interface Unlock {
  token: string;
  expiresAt: number;
}

export function VaultPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const status = useLoad(() => get<VaultStatus>('/api/vault'), []);
  const hidden = useLoad(
    () => (status.data?.unlocked ? get<Novel[]>('/api/vault/novels') : Promise.resolve([] as Novel[])),
    [status.data?.unlocked]
  );
  const [pin, setPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const action = useAction();

  const took = (u: Unlock | undefined) => {
    if (!u) return;
    settings.setVaultToken(u.token);
    setPin('');
    setNewPin('');
    void status.reload();
    onChanged();
  };

  const s = status.data;
  return (
    <Modal title="Vault" onClose={onClose}>
      <p className="dim small">Hidden novels stay off the shelf and only open while the vault is unlocked with your PIN.</p>
      <ErrorLine text={status.error} />
      {s && !s.pinSet && (
        <div className="card">
          <Field label="Choose a PIN">
            <input type="password" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
          </Field>
          <button disabled={action.busy || !newPin} onClick={async () => took(await action.run(() => post<Unlock>('/api/vault/pin', { pin: newPin })))}>
            Set PIN
          </button>
        </div>
      )}
      {s && s.pinSet && !s.unlocked && (
        <div className="card">
          <Field label="PIN">
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') took(await action.run(() => post<Unlock>('/api/vault/unlock', { pin })));
              }}
            />
          </Field>
          <button disabled={action.busy || !pin} onClick={async () => took(await action.run(() => post<Unlock>('/api/vault/unlock', { pin })))}>
            Unlock
          </button>
        </div>
      )}
      {s && s.unlocked && (
        <>
          <div className="row">
            <span className="ok">Unlocked</span>
            <span className="grow" />
            <button
              className="ghost"
              onClick={() => {
                settings.setVaultToken('');
                void status.reload();
                onChanged();
              }}
            >
              Lock
            </button>
          </div>
          <h3>Hidden novels</h3>
          {(hidden.data ?? []).length === 0 && <p className="dim small">Nothing hidden. Hide a novel from its Settings tab.</p>}
          <ul className="plain">
            {(hidden.data ?? []).map((n) => (
              <li key={n.id}>
                <button
                  className="link"
                  onClick={() => {
                    go(n.id, 'write');
                    onClose();
                  }}
                >
                  {n.title}
                </button>{' '}
                <span className="dim small">{n.chapterCount} ch</span>
              </li>
            ))}
          </ul>
          <hr />
          <details>
            <summary>Change or remove PIN</summary>
            <Field label="Current PIN">
              <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
            <Field label="New PIN">
              <input type="password" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
            </Field>
            <div className="row">
              <button
                disabled={action.busy || !pin || !newPin}
                onClick={async () => took(await action.run(() => post<Unlock>('/api/vault/pin', { pin: newPin, currentPin: pin })))}
              >
                Change PIN
              </button>
              <button
                className="danger"
                disabled={action.busy || !pin}
                onClick={async () => {
                  if (!confirm('Remove the PIN? Every hidden novel goes back on the shelf.')) return;
                  const r = await action.run(() => del<{ ok: boolean; unhidden: number }>('/api/vault/pin', { pin }));
                  if (r) {
                    settings.setVaultToken('');
                    setPin('');
                    void status.reload();
                    onChanged();
                  }
                }}
              >
                Remove PIN
              </button>
            </div>
          </details>
        </>
      )}
      <ErrorLine text={action.error} />
    </Modal>
  );
}
