'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, type FormEvent } from 'react';
import { ActionButton, ConfirmDialog, Icons, useToast } from '@sideout/ui';

import type { TournamentFormat, TournamentStatus } from '../../db/schema';
import type { DrawConfig } from '../../domain/draw-config';
import { api, fieldIssues } from '../../lib/api-client';
import { cx } from '../../lib/cx';
import { Bracket } from '../bracket/Bracket';
import { nodesFromDraw, type DrawMatchLike } from '../bracket/model';
import { PoolTable, type PoolMatchRef, type PoolTeamRef } from '../bracket/PoolTable';
import { Field, Fieldset, Select, TextInput } from '../ui/Form';
import { Notice } from '../ui/Notice';

/**
 * The draw section of the builder (spec 5.3, "event builder with live draw preview").
 * Every preview is `POST /api/admin/tournaments/:id/draw?preview=1`, rendered with the
 * same `PoolTable` and `Bracket` the public tabs use; commit resends the previewed
 * `rngSeed`, so what was shown is exactly what is written.
 *
 * Two stages: pools (while registration is closed; a redraw replaces an unstarted draw)
 * and, for pool-to-bracket events once every pool match is complete, seeding the bracket
 * from the standings, which takes no configuration (docs/decisions.md, phase 6).
 */
export type DrawOutcomeView = {
  stage: 'pools' | 'bracket';
  persisted: boolean;
  config: DrawConfig;
  pools: Array<{ sequence: number; label: string; courtLabel: string; teamIds: string[] }>;
  bracket: { size: number; rounds: number; seeds: Array<{ seed: number; teamId: string }> } | null;
  lots: Array<{ tied: string[]; order: string[] }>;
  matches: DrawMatchLike[];
};

export type DrawPanelProps = {
  tournamentId: string;
  format: TournamentFormat;
  status: TournamentStatus;
  timeZone: string;
  teams: ReadonlyArray<{ id: string; name: string; seed: number | null }>;
  existing: { matchCount: number; started: boolean; bracketSeeded: boolean; poolsDone: boolean; unfinishedPoolMatches: number; config: DrawConfig | null };
};

type FormValues = { courts: string; poolSize: string; perPool: string; wildcards: string; poolBestOf: '1' | '3'; bracketBestOf: '1' | '3' };

function initialForm(props: DrawPanelProps): FormValues {
  const c = props.existing.config;
  return {
    courts: String(c?.courts ?? 4),
    poolSize: String(c?.format === 'pool_to_bracket' ? c.poolSize : 4),
    perPool: String(c?.format === 'pool_to_bracket' ? c.advancement.perPool : 2),
    wildcards: String(c?.format === 'pool_to_bracket' ? c.advancement.wildcards : 0),
    poolBestOf: c?.format === 'pool_to_bracket' || c?.format === 'round_robin' ? (String(c.bestOf.pool) as '1' | '3') : '1',
    bracketBestOf: c?.format === 'pool_to_bracket' || c?.format === 'single_elim' ? (String(c.bestOf.bracket) as '1' | '3') : '3',
  };
}

function int(value: string, label: string, min: number, max: number): { ok: true; value: number } | { ok: false; message: string } {
  const n = Number(value);
  if (!Number.isInteger(n)) return { ok: false, message: `${label} must be a whole number.` };
  if (n < min) return { ok: false, message: `${label} must be at least ${min}.` };
  if (n > max) return { ok: false, message: `${label} must be at most ${max}.` };
  return { ok: true, value: n };
}

function poolsFromOutcome(outcome: DrawOutcomeView, names: Map<string, { name: string; seed: number | null }>): Array<{ key: string; label: string; courtLabel: string; teams: PoolTeamRef[]; matches: PoolMatchRef[] }> {
  return outcome.pools.map((pool) => ({
    key: `pool-${pool.sequence}`,
    label: pool.label,
    courtLabel: pool.courtLabel,
    teams: pool.teamIds.map((id) => ({ id, name: names.get(id)?.name ?? 'Team', seed: names.get(id)?.seed ?? null, members: [] })),
    matches: outcome.matches
      .filter((m) => m.poolSequence === pool.sequence)
      .map((m, i) => ({ id: `pool-${pool.sequence}-${i}`, teamAId: m.teamAId, teamBId: m.teamBId, status: m.status, winnerId: null, sets: [], round: m.round, scheduledAt: m.scheduledAt, href: null })),
  }));
}

export function DrawPanel(props: DrawPanelProps) {
  const { tournamentId, format, status, timeZone, teams, existing } = props;
  const router = useRouter();
  const { toast } = useToast();
  const headingId = useId();
  const [form, setForm] = useState<FormValues>(() => initialForm(props));
  const [seeds, setSeeds] = useState<Record<string, string>>(() => Object.fromEntries(teams.map((t) => [t.id, t.seed === null ? '' : String(t.seed)])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [preview, setPreview] = useState<DrawOutcomeView | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Bumped on every input edit, so a preview that answers older inputs is dropped when it lands. */
  const edits = useRef(0);

  const poolsStage = status === 'registration_closed';
  const bracketStage = status === 'live' && format === 'pool_to_bracket' && !existing.bracketSeeded && existing.matchCount > 0;
  if (!poolsStage && !bracketStage) return null;

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    edits.current += 1;
    setForm((f) => ({ ...f, [key]: value }));
    setPreview(null);
  };
  const setSeed = (teamId: string, value: string) => {
    edits.current += 1;
    setSeeds((s) => ({ ...s, [teamId]: value }));
    setPreview(null);
  };
  const usesPools = format === 'pool_to_bracket' || format === 'round_robin';
  const usesBracket = format === 'pool_to_bracket' || format === 'single_elim';
  const names = new Map(teams.map((t) => [t.id, { name: t.name, seed: t.seed }]));

  function stageRequest(): Record<string, unknown> | null {
    const next: Record<string, string> = {};
    const courts = int(form.courts, 'Courts', 1, 64);
    const poolSize = int(form.poolSize, 'Pool size', 2, 8);
    const perPool = int(form.perPool, 'Advance per pool', 1, 8);
    const wildcards = int(form.wildcards, 'Wildcards', 0, 32);
    if (!courts.ok) next['courts'] = courts.message;
    if (usesPools && !poolSize.ok) next['poolSize'] = poolSize.message;
    if (format === 'pool_to_bracket' && !perPool.ok) next['perPool'] = perPool.message;
    if (format === 'pool_to_bracket' && !wildcards.ok) next['wildcards'] = wildcards.message;
    const seedList: Array<{ teamId: string; seed: number }> = [];
    const used = new Map<number, string>();
    for (const t of teams) {
      const raw = (seeds[t.id] ?? '').trim();
      if (raw === '') continue;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        next[`seed.${t.id}`] = 'Seeds are whole numbers from 1.';
        continue;
      }
      const other = used.get(value);
      if (other !== undefined) {
        next[`seed.${t.id}`] = `Seed ${value} is also given to ${other}.`;
        continue;
      }
      used.set(value, t.name);
      seedList.push({ teamId: t.id, seed: value });
    }
    setErrors(next);
    if (Object.keys(next).length > 0 || !courts.ok) {
      setFailure('Fix the highlighted fields.');
      return null;
    }
    const bestOf = { ...(usesPools ? { pool: Number(form.poolBestOf) } : {}), ...(usesBracket ? { bracket: Number(form.bracketBestOf) } : {}) };
    if (format === 'single_elim') return { stage: 'bracket', courts: courts.value, bestOf: { bracket: Number(form.bracketBestOf) }, ...(seedList.length > 0 ? { seeds: seedList } : {}) };
    return {
      stage: 'pools',
      courts: courts.value,
      ...(poolSize.ok && format === 'pool_to_bracket' ? { poolSize: poolSize.value } : {}),
      ...(format === 'pool_to_bracket' && perPool.ok && wildcards.ok ? { advancement: { perPool: perPool.value, wildcards: wildcards.value } } : {}),
      bestOf,
      ...(seedList.length > 0 ? { seeds: seedList } : {}),
    };
  }

  async function run(mode: 'preview' | 'commit', event?: FormEvent) {
    event?.preventDefault();
    setFailure(null);
    let body: Record<string, unknown> | null;
    if (bracketStage) body = { stage: 'bracket' };
    else {
      body = stageRequest();
      if (body === null) return;
      if (mode === 'commit' && preview !== null) body['rngSeed'] = preview.config.rngSeed;
    }
    const editsAtSend = edits.current;
    setBusy(mode);
    const result = await api<DrawOutcomeView>(`/api/admin/tournaments/${tournamentId}/draw${mode === 'preview' ? '?preview=1' : ''}`, { method: 'POST', body });
    setBusy(null);
    setConfirming(false);
    if (!result.ok) {
      const issues = result.error.code === 'validation_failed' ? fieldIssues(result.error) : {};
      if (Object.keys(issues).length > 0) setErrors(issues);
      setFailure(result.error.message);
      return;
    }
    if (mode === 'preview') {
      if (editsAtSend === edits.current) setPreview(result.data);
      return;
    }
    setPreview(null);
    toast({ tone: 'success', title: bracketStage ? 'Bracket seeded' : existing.matchCount > 0 ? 'Draw replaced' : 'Draw generated', body: 'Pools, courts and the bracket are written; the public tabs show them now.' });
    router.refresh();
  }

  const previewPools = preview === null ? [] : poolsFromOutcome(preview, names);
  const previewNodes = preview === null ? [] : nodesFromDraw(preview.matches, Object.fromEntries(names));

  return (
    <section aria-labelledby={headingId} className="space-y-5" data-testid="draw-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id={headingId} className="type-heading">
          {bracketStage ? 'Seed the bracket' : existing.matchCount > 0 ? 'Redraw' : 'Draw'}
        </h2>
        <span className="tabular type-label text-text-tertiary">{teams.length} teams confirmed</span>
      </div>

      {existing.started ? (
        <Notice tone="info" title="The draw is locked">
          A match has already started, so pools and the bracket can no longer be replaced.
        </Notice>
      ) : null}
      {poolsStage && existing.matchCount > 0 && !existing.started ? (
        <Notice tone="attention" title="A draw already exists">
          Committing a new one replaces every pool and match. Nothing has started yet, so that is still allowed.
        </Notice>
      ) : null}
      {bracketStage && !existing.poolsDone ? (
        <Notice tone="info" title="Pool play is still going">
          {`${existing.unfinishedPoolMatches} pool ${existing.unfinishedPoolMatches === 1 ? 'match is' : 'matches are'} unresolved. The bracket is seeded from the final standings once every pool match is final or forfeited; ties at a cut line are drawn by lot.`}
        </Notice>
      ) : null}
      {failure === null ? null : (
        <Notice tone="error" title="Could not run the draw">
          {failure}
        </Notice>
      )}

      {poolsStage && !existing.started ? (
        <form onSubmit={(event) => void run('preview', event)} noValidate className="space-y-6">
          <Fieldset legend="Courts and pools" description="Pool matches are 30 minutes and bracket matches 45, with a 15-minute break between stages; times are derived from the event start.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Courts" error={errors['courts']}>
                {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={1} max={64} value={form.courts} onChange={(e) => set('courts', e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
              </Field>
              {format === 'pool_to_bracket' ? (
                <>
                  <Field label="Pool size" error={errors['poolSize']} hint="Pools differ by at most one; never a pool of one.">
                    {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={2} max={8} value={form.poolSize} onChange={(e) => set('poolSize', e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                  </Field>
                  <Field label="Advance per pool" error={errors['perPool']}>
                    {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={1} max={8} value={form.perPool} onChange={(e) => set('perPool', e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                  </Field>
                  <Field label="Wildcards" error={errors['wildcards']} hint="Best remaining teams ranked across pools.">
                    {({ id, describedBy, invalid }) => <TextInput id={id} type="number" inputMode="numeric" min={0} max={32} value={form.wildcards} onChange={(e) => set('wildcards', e.target.value)} aria-describedby={describedBy} invalid={invalid} />}
                  </Field>
                </>
              ) : null}
              {usesPools ? (
                <Field label="Pool matches" error={errors['poolBestOf']}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={form.poolBestOf} onChange={(e) => set('poolBestOf', e.target.value as '1' | '3')} aria-describedby={describedBy} invalid={invalid}>
                      <option value="1">Best of 1</option>
                      <option value="3">Best of 3</option>
                    </Select>
                  )}
                </Field>
              ) : null}
              {usesBracket ? (
                <Field label="Bracket matches" error={errors['bracketBestOf']}>
                  {({ id, describedBy, invalid }) => (
                    <Select id={id} value={form.bracketBestOf} onChange={(e) => set('bracketBestOf', e.target.value as '1' | '3')} aria-describedby={describedBy} invalid={invalid}>
                      <option value="1">Best of 1</option>
                      <option value="3">Best of 3</option>
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>
          </Fieldset>
          <Fieldset legend="Entry seeds" description="Seeded teams are placed first, strongest as 1; unseeded teams are shuffled. Leave blank for none.">
            {teams.length === 0 ? (
              <p className="text-text-tertiary">No confirmed teams yet.</p>
            ) : (
              <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {teams.map((t) => (
                  <li key={t.id} className="surface-raised flex items-center gap-3 rounded-input px-3 py-2">
                    <label htmlFor={`seed-${t.id}`} className="min-w-0 flex-1 truncate font-medium text-text-primary">
                      {t.name}
                    </label>
                    <span className="w-20 shrink-0">
                      <TextInput id={`seed-${t.id}`} type="number" inputMode="numeric" min={1} value={seeds[t.id] ?? ''} onChange={(e) => setSeed(t.id, e.target.value)} aria-label={`Seed for ${t.name}`} invalid={errors[`seed.${t.id}`] !== undefined} className="text-end" placeholder="—" />
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {Object.entries(errors)
              .filter(([k]) => k.startsWith('seed.'))
              .map(([k, v]) => (
                <p key={k} role="alert" className="mt-2 text-fault">
                  {v}
                </p>
              ))}
          </Fieldset>
          <div className="flex flex-wrap gap-2">
            <ActionButton type="submit" variant="secondary" disabled={busy !== null || teams.length < 2} aria-busy={busy === 'preview'} iconStart={<Icons.shuffle size={16} />}>
              {busy === 'preview' ? 'Drawing…' : 'Preview draw'}
            </ActionButton>
            {preview === null ? null : (
              <ActionButton variant="primary" disabled={busy !== null} onClick={() => setConfirming(true)} iconStart={<Icons.check size={16} />}>
                Commit this draw
              </ActionButton>
            )}
          </div>
        </form>
      ) : null}

      {bracketStage ? (
        <div className="flex flex-wrap gap-2">
          <ActionButton variant="secondary" disabled={busy !== null || !existing.poolsDone} aria-busy={busy === 'preview'} onClick={() => void run('preview')} iconStart={<Icons.bracket size={16} />}>
            {busy === 'preview' ? 'Ranking pools…' : 'Preview seeding'}
          </ActionButton>
          {preview === null ? null : (
            <ActionButton variant="primary" disabled={busy !== null} onClick={() => setConfirming(true)} iconStart={<Icons.check size={16} />}>
              Seed the bracket
            </ActionButton>
          )}
        </div>
      ) : null}

      {preview === null ? null : (
        <div className="space-y-5" aria-live="polite" data-testid="draw-preview">
          <Notice tone="info" title="Preview only: nothing is written until you commit">
            <span className="tabular">
              {preview.pools.length > 0 ? `${preview.pools.length} pools (${preview.pools.map((p) => p.teamIds.length).join(', ')} teams)` : 'No pools'} ·{' '}
              {preview.bracket === null ? 'No bracket' : `${preview.bracket.size}-slot bracket, ${preview.bracket.rounds} rounds`} · {preview.matches.length} matches · seed {preview.config.rngSeed}
            </span>
          </Notice>
          {preview.lots.length > 0 ? (
            <p className="text-text-secondary">
              {preview.lots.length === 1 ? 'One tie at a cut line was' : `${preview.lots.length} ties at cut lines were`} drawn by lot:{' '}
              {preview.lots.map((lot) => lot.order.map((id) => names.get(id)?.name ?? id).join(' over ')).join('; ')}.
            </p>
          ) : null}
          {previewPools.length > 0 ? (
            <div className={cx('grid grid-cols-1 gap-4', previewPools.length > 1 && 'lg:grid-cols-2')}>
              {previewPools.map((pool) => (
                <PoolTable key={pool.key} label={pool.label} courtLabel={pool.courtLabel} teams={pool.teams} matches={pool.matches} timeZone={timeZone} />
              ))}
            </div>
          ) : null}
          {previewNodes.length > 0 ? <Bracket nodes={previewNodes} timeZone={timeZone} label="Draw preview" /> : null}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={bracketStage ? 'Seed the bracket from the pool standings?' : existing.matchCount > 0 ? 'Replace the existing draw?' : 'Commit this draw?'}
        body={bracketStage ? 'Round 1 is filled from the standings you previewed; byes advance immediately.' : 'Pools, courts, times and the bracket skeleton are written exactly as previewed.'}
        confirmLabel={bracketStage ? 'Seed bracket' : 'Commit draw'}
        busy={busy === 'commit'}
        onConfirm={() => void run('commit')}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
