import { ROLE_LABELS, type ModelRoles, type ProseProfile, type RoleName } from '../lib/harnessTypes';

export function HarnessSettings({ roles, onRoles, prose, onProse }: { roles: ModelRoles; onRoles: (v: ModelRoles) => void; prose: ProseProfile; onProse: (v: ProseProfile) => void }) {
  const update = (role: RoleName, patch: ModelRoles[RoleName]) => onRoles({ ...roles, [role]: { ...roles[role], ...patch } });
  return <div className="harness-settings mt-5 stack">
    <details className="rounded-lg border border-line p-3">
      <summary className="font-medium">Models by role</summary>
      <p className="mt-2 text-xs text-muted">Leave a model blank to keep its default. Fallbacks are tried only before a response starts. Spending limits stop between calls; an in-flight call may exceed the limit.</p>
      {(Object.keys(ROLE_LABELS) as RoleName[]).map(role => <fieldset key={role} className="mt-3 rounded border border-line p-2">
        <legend>{ROLE_LABELS[role]}</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
          <label>Model<input aria-label={`${ROLE_LABELS[role]} model`} className="w-full rounded border border-line p-1" value={roles[role]?.model ?? ''} placeholder="provider/model" onChange={e => update(role, { model: e.target.value })} /></label>
          <label>Fallback<input aria-label={`${ROLE_LABELS[role]} fallback`} className="w-full rounded border border-line p-1" value={roles[role]?.fallbackModels?.[0] ?? ''} placeholder="provider/model" onChange={e => update(role, { fallbackModels: e.target.value ? [e.target.value] : [] })} /></label>
          <label>Output token limit<input aria-label={`${ROLE_LABELS[role]} token limit`} className="w-full rounded border border-line p-1" type="number" min={256} max={32000} value={roles[role]?.maxOutputTokens ?? ''} onChange={e => update(role, { maxOutputTokens: e.target.value ? Number(e.target.value) : undefined })} /></label>
          <label>Spending limit ($)<input aria-label={`${ROLE_LABELS[role]} spending limit`} className="w-full rounded border border-line p-1" type="number" min={0.001} max={100} step="any" value={roles[role]?.budgetUsd ?? ''} onChange={e => update(role, { budgetUsd: e.target.value ? Number(e.target.value) : undefined })} /></label>
        </div>
      </fieldset>)}
    </details>
    <details className="mt-3 rounded-lg border border-line p-3">
      <summary className="font-medium">Voice and editing preferences</summary>
      <label className="mt-2 block">Genre / register<input aria-label="Genre / register" className="w-full rounded border border-line p-1" maxLength={120} value={prose.genre ?? ''} onChange={e => onProse({ ...prose, genre: e.target.value })} /></label>
      <label className="mt-2 block">Your voice sample<textarea aria-label="Your voice sample" className="w-full rounded border border-line p-1" rows={4} maxLength={4000} value={prose.voiceSample ?? ''} onChange={e => onProse({ ...prose, voiceSample: e.target.value })} /></label>
      <label className="mt-2 block">Facts an edit must preserve<textarea aria-label="Facts an edit must preserve" className="w-full rounded border border-line p-1" rows={3} maxLength={2000} value={prose.protectedFacts ?? ''} onChange={e => onProse({ ...prose, protectedFacts: e.target.value })} /></label>
      <p className="mt-2 text-xs text-muted">Optional prose checks to disable for this novel’s style:</p>
      {(['emDash', 'thematicClose', 'dialogueCoda', 'thinDialogue', 'lowDialogue', 'short'] as const).map(metric => <label key={metric} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={prose.disabledMetrics?.includes(metric) ?? false} onChange={e => onProse({ ...prose, disabledMetrics: e.target.checked ? [...(prose.disabledMetrics ?? []), metric] : prose.disabledMetrics?.filter(m => m !== metric) })} />{{ emDash: 'Em dashes', thematicClose: 'Thematic endings', dialogueCoda: 'Dialogue tags', thinDialogue: 'Brief dialogue', lowDialogue: 'Dialogue frequency', short: 'Chapter length' }[metric]}</label>)}
    </details>
  </div>;
}
