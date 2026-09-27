import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isSafeModelId } from '../engine/models.js';
import { ValidationError } from './validate.js';

export const MODEL_ROLES = ['writer', 'planner', 'bible', 'summarizer', 'editor', 'characters', 'checker', 'map', 'suggestions', 'naming', 'power'] as const;
export type ModelRole = typeof MODEL_ROLES[number];
export interface RoleModel {
  model?: string;
  fallbackModels?: string[];
  maxOutputTokens?: number;
  /** Stop before the next call after this recorded spend; not an upstream billing cap. */
  budgetUsd?: number;
}
export type ModelRoles = Partial<Record<ModelRole, RoleModel>>;
export interface ModelRun {
  role: ModelRole;
  model: string;
  provider: string | null;
  promptHash: string;
  promptVersion: string;
  cost: number | null;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  outcome: 'completed' | 'failed';
}
interface Policy { roles: ModelRoles; runs: ModelRun[] }
const context = new AsyncLocalStorage<Policy>();
export const withModelPolicy = <T>(roles: ModelRoles, work: () => T): T => context.run({ roles, runs: [] }, work);
export function configureModelPolicy(roles: ModelRoles = {}): void {
  const policy = context.getStore();
  if (policy) policy.roles = roles;
}
export const rolePolicy = (role: ModelRole): RoleModel => context.getStore()?.roles[role] ?? {};
export const modelRuns = (): ModelRun[] => [...(context.getStore()?.runs ?? [])];
export function seedModelRuns(runs: ModelRun[]): void { const policy = context.getStore(); if (policy) policy.runs = [...runs]; }
export function recordModelRun(run: ModelRun): void { context.getStore()?.runs.push(run); }
export function assertRoleBudget(role: ModelRole): void {
  const budget = rolePolicy(role).budgetUsd;
  if (budget && modelRuns().some(r => r.role === role && r.outcome === 'completed' && r.cost === null)) throw new Error(`The ${role} provider did not report its cost. Progress is kept; remove the spending limit to continue without cost enforcement.`);
  const spent = modelRuns().filter(r => r.role === role).reduce((sum, r) => sum + (r.cost ?? 0), 0);
  if (budget && spent >= budget) throw new Error(`The ${role} spending limit was reached. Progress is kept; raise the limit to continue.`);
}
export const promptHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validateModelRoles(raw: unknown): ModelRoles {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('modelRoles must be an object');
  const result: ModelRoles = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(MODEL_ROLES as readonly string[]).includes(key)) throw new ValidationError(`Unknown model role: ${key}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`Invalid settings for ${key}`);
    const v = value as Record<string, unknown>;
    const config: RoleModel = {};
    if (v.model !== undefined && v.model !== '') {
      if (typeof v.model !== 'string' || v.model.length > 160 || !isSafeModelId(v.model)) throw new ValidationError(`Invalid ${key} model`);
      config.model = v.model;
    }
    if (v.fallbackModels !== undefined) {
      if (!Array.isArray(v.fallbackModels) || v.fallbackModels.length > 3 || v.fallbackModels.some(m => typeof m !== 'string' || m.length > 160 || !isSafeModelId(m))) throw new ValidationError(`${key} supports up to three valid fallback models`);
      config.fallbackModels = [...new Set(v.fallbackModels)] as string[];
    }
    if (v.maxOutputTokens !== undefined) {
      if (typeof v.maxOutputTokens !== 'number' || !Number.isInteger(v.maxOutputTokens) || v.maxOutputTokens < 256 || v.maxOutputTokens > 32000) throw new ValidationError(`${key} output limit must be 256–32000 tokens`);
      config.maxOutputTokens = v.maxOutputTokens;
    }
    if (v.budgetUsd !== undefined) {
      if (typeof v.budgetUsd !== 'number' || !Number.isFinite(v.budgetUsd) || v.budgetUsd <= 0 || v.budgetUsd > 100) throw new ValidationError(`${key} budget must be greater than 0 and at most $100`);
      config.budgetUsd = v.budgetUsd;
    }
    result[key as ModelRole] = config;
  }
  return result;
}
