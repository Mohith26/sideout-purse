import type { Metadata } from 'next';
import Link from 'next/link';
import { DataTable } from '@sideout/ui';
import type { RulesetSummaryResource } from '@purse/types';

import { PageHead } from '../../../components/PageHead';
import { StateChip } from '../../../components/StateChip';
import { formatInstant } from '../../../lib/format';
import { load } from '../../../server/api';

export const metadata: Metadata = { title: 'Rulesets' };

/** The version history (spec 4.5, decision D9): a version is written once; exactly one is active. */
export default async function RulesetsPage() {
  const { rulesets } = await load<{ rulesets: RulesetSummaryResource[] }>('/rulesets', '/rulesets');
  return (
    <>
      <PageHead
        title="Rulesets"
        lede="The eligibility rules, versioned. A version never changes once stored; a new version is created from the current one and activated on purpose. Every persisted decision names the version that made it."
        actions={
          <Link href="/rulesets/new" className="so-button so-button--primary so-button--small">
            New version
          </Link>
        }
      />
      <DataTable
        caption="Ruleset versions"
        rows={rulesets}
        rowKey={(row) => row.version}
        empty="No rulesets; run pnpm db:seed."
        columns={[
          {
            key: 'version',
            header: 'Version',
            render: (row) => (
              <Link href={`/rulesets/${row.version}`} className="so-link so-mono">
                {row.version}
              </Link>
            ),
          },
          { key: 'active', header: 'Status', render: (row) => (row.active ? <StateChip value="active" /> : <span className="label">inactive</span>) },
          { key: 'created', header: 'Stored', render: (row) => formatInstant(row.createdAt) },
          { key: 'updated', header: 'Changed', render: (row) => formatInstant(row.updatedAt) },
        ]}
      />
    </>
  );
}
