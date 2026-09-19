'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icons } from '@sideout/ui';

import { canSign, currentDeviceKey } from '../../lib/attestation/device';
import { cx } from '../../lib/cx';

/**
 * One line on the match page and the profile: whether this phone is checked in for the
 * team, judged on the phone by comparing its own key id with the team's live check-ins,
 * with the way to the check-in step when it is not. Nothing is known until the key store
 * has answered, so the line renders quietly first.
 */
export function PhoneCheckInStatus({ teamName, liveKeyIds, checkInHref, className }: { teamName: string; liveKeyIds: readonly string[]; checkInHref: string; className?: string }) {
  const [keyId, setKeyId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!canSign()) {
        setKeyId(null);
        return;
      }
      void currentDeviceKey().then((key) => {
        if (!cancelled) setKeyId(key?.keyId ?? null);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (keyId === undefined) return <p className={cx('type-label text-text-tertiary', className)} data-testid="phone-status" data-status="loading" />;
  const checkedIn = keyId !== null && liveKeyIds.includes(keyId);
  // A sentence with an inline link (WCAG 2.5.8's exception), so a paragraph, not a control row.
  return (
    <p className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 type-label', checkedIn ? 'text-surf' : 'text-text-tertiary', className)} data-testid="phone-status" data-status={checkedIn ? 'checked_in' : 'not_checked_in'}>
      <Icons.smartphone size={14} />
      {checkedIn ? (
        <span>This phone is checked in for {teamName}; scorelines from it are signed.</span>
      ) : (
        <span>
          This phone is not checked in for {teamName}; scorelines from it are sent unsigned.{' '}
          <Link href={checkInHref} className="link-inline text-text-primary hover:text-volt">
            Check it in
          </Link>
        </span>
      )}
    </p>
  );
}
