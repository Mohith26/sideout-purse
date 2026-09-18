import type { Metadata } from 'next';
import type { ReconcileResource } from '@purse/types';

import { InvariantPanel } from '../../../components/InvariantPanel';
import { PageHead } from '../../../components/PageHead';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Invariants' };

/** The live invariant panel (spec 4.10): `reconcile()` on demand and every 60 seconds while the page is open. */
export default async function InvariantsPage() {
  const report = await load<ReconcileResource>('/reconcile', '/invariants');
  return (
    <>
      <PageHead title="Invariants" lede="The seven invariants of spec 4.2.4, checked against the whole ledger by reconcile(). Red on any failure; the same routine runs in CI and on the production schedule." />
      <InvariantPanel initial={report} />
    </>
  );
}
