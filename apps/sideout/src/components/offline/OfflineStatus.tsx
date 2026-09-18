'use client';

import { useEffect, useRef, useState } from 'react';
import { Icons, useToast } from '@sideout/ui';

import { cx } from '../../lib/cx';
import { subscribeOutbox, syncOutbox } from '../../lib/offline/client';
import type { OutboxItem, ReplayReport } from '../../lib/offline/outbox';
import { useConnectivity } from './useConnectivity';

/**
 * The shell's connectivity surface: a plain status line while the phone is offline (what
 * still works, what is waiting), and the outbox replay, on load, on reconnect and when the
 * tab comes back, with one toast per outcome so a player learns their queued scoreline went
 * through, or why it did not, wherever they are in the app.
 */
export function OfflineStatus() {
  const { offline } = useConnectivity();
  const { toast } = useToast();
  const [queued, setQueued] = useState<OutboxItem[]>([]);
  const wasOffline = useRef(false);

  useEffect(() => subscribeOutbox((items) => setQueued(items.filter((i) => i.status === 'queued'))), []);

  useEffect(() => {
    const announce = (report: ReplayReport) => {
      for (const outcome of report.outcomes) {
        if (outcome.result === 'sent') toast({ tone: 'success', title: 'Queued scoreline sent', body: 'Your result reached Sideout. The match page shows where it stands.' });
        else if (outcome.result === 'failed') toast({ tone: 'error', title: 'Queued scoreline refused', body: outcome.message ?? 'The server did not accept it.', durationMs: 0 });
        else if (outcome.result === 'settled_elsewhere') toast({ tone: 'neutral', title: 'Queued scoreline no longer needed', body: outcome.message ?? 'The match has since been settled.' });
      }
    };
    const run = () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      void syncOutbox().then(announce);
    };
    run();
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [toast]);

  useEffect(() => {
    if (offline) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      void syncOutbox();
    }
  }, [offline]);

  return (
    <div role="status" aria-live="polite" data-testid="offline-status" data-offline={offline ? 'true' : 'false'} className={cx(!offline && 'sr-only')}>
      {offline ? (
        <p className="mx-auto flex max-w-content items-start gap-3 border-b border-border-subtle bg-bg-inset px-gutter py-3 text-text-secondary">
          <Icons.wifiOff size={18} className="mt-0.5 shrink-0 text-text-tertiary" />
          <span>
            <span className="font-medium text-text-primary">No connection.</span> Pages you have already opened still work.
            {queued.length > 0
              ? ` ${queued.length === 1 ? 'One scoreline is' : `${queued.length} scorelines are`} saved on this phone and will be sent when you are back online.`
              : ' A score you submit now is saved on this phone and sent when you are back online.'}
          </span>
        </p>
      ) : null}
    </div>
  );
}
