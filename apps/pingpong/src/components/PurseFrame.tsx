'use client';

import { useEffect, useRef, useState } from 'react';
import { Purse, type PurseEvents } from '@purse/sdk';
import type { EmbedFlow, FlowResult } from '@purse/types';

import { api } from '../lib/api-client';

/**
 * The one component that mounts `@purse/sdk` flows in the browser (spec 4.8): it asks the
 * server for a single-use embed token (`POST /api/me/purse/embed-token`), initialises the
 * SDK with the publishable key and tenant the server hands back, mounts the flow into its
 * own slot on this page, and reports the outcome. Nothing else imports the SDK; ESLint
 * refuses it (`packages/config/eslint/boundary.js`).
 */
export type Grant = { token: string; contestId: string | null; purseOrigin: string; publishableKey: string; tenantId: string };

export type FrameOutcome = { ok: true; result: FlowResult } | { ok: false; code: string; message: string };

const THEME = { accent: '#D7FF3E', surface: '#101216', radius: 10, font: 'Instrument Sans' } as const;

export function PurseFrame({ flow, seasonId, onDone }: { flow: EmbedFlow; seasonId?: string; onDone: (outcome: FrameOutcome) => void }) {
  const slot = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(420);
  const [status, setStatus] = useState<string>('Opening Purse…');
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    let purse: Purse | null = null;
    let settled = false;
    const finish = (outcome: FrameOutcome) => {
      if (settled) return;
      settled = true;
      done.current(outcome);
    };
    void (async () => {
      const minted = await api<Grant>('/api/me/purse/embed-token', { body: { flow, ...(seasonId === undefined ? {} : { seasonId }) } });
      if (!minted.ok) return finish({ ok: false, code: minted.error.code, message: minted.error.message });
      const grant = minted.data;
      if (slot.current === null) return finish({ ok: false, code: 'slot_missing', message: 'The Purse slot is missing.' });
      try {
        purse = await Purse.init({ publishableKey: grant.publishableKey, tenantId: grant.tenantId, purseOrigin: grant.purseOrigin, theme: { ...THEME } });
        purse.on('flow:complete', (result: PurseEvents['flow:complete']) => {
          setStatus('Done.');
          finish({ ok: true, result });
        });
        purse.on('error', (error: PurseEvents['error']) => {
          setStatus(error.message);
          if (error.type === 'internal_error' || error.type === 'authentication_error') finish({ ok: false, code: error.code, message: error.message });
        });
        purse.on('resize', ({ height: reported }: PurseEvents['resize']) => setHeight(Math.max(240, Math.min(900, reported))));
        await purse.mount(slot.current, { flow, embedToken: grant.token, ...(grant.contestId === null ? {} : { contestId: grant.contestId }), initialHeight: 420 });
        setStatus('');
      } catch (caught) {
        finish({ ok: false, code: 'mount_failed', message: caught instanceof Error ? caught.message : String(caught) });
      }
    })();
    return () => {
      purse?.unmount();
    };
  }, [flow, seasonId]);

  return (
    <div data-testid="purse-frame">
      {status === '' ? null : (
        <p className="type-label mb-2" role="status">
          {status}
        </p>
      )}
      <div ref={slot} className="pp-slot" data-testid="purse-slot" style={{ minHeight: height }} />
    </div>
  );
}
