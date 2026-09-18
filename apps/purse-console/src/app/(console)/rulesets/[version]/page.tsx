import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, DataTable, Mono } from '@sideout/ui';
import type { AuditRowResource, ConsoleMeResource, RulesetResource } from '@purse/types';

import { PageHead } from '../../../../components/PageHead';
import { StateChip } from '../../../../components/StateChip';
import { formatInstant } from '../../../../lib/format';
import { load } from '../../../../server/api';
import { ActivateRuleset } from './ActivateRuleset';

export const metadata: Metadata = { title: 'Ruleset' };

export default async function RulesetPage({ params }: { params: Promise<{ version: string }> }) {
  const { version } = await params;
  const [ruleset, me, { audit }] = await Promise.all([load<RulesetResource>(`/rulesets/${version}`, `/rulesets/${version}`), load<ConsoleMeResource>('/auth/me'), load<{ audit: AuditRowResource[] }>(`/audit?subject=${encodeURIComponent(`ruleset:${version}`)}`)]);
  return (
    <>
      <PageHead
        title={`Ruleset ${ruleset.version}`}
        crumbs={[{ label: 'Rulesets', href: '/rulesets' }, { label: ruleset.version }]}
        actions={
          <>
            {ruleset.active ? <StateChip value="active" /> : <span className="label">inactive</span>}
            <Link href={`/rulesets/new?from=${ruleset.version}`} className="so-button so-button--secondary so-button--small">
              New version from this
            </Link>
            <Link href={`/rulesets/tester?version=${ruleset.version}`} className="so-button so-button--secondary so-button--small">
              Test this version
            </Link>
          </>
        }
      />
      <div className="grid grid--two">
        <Card title="Body">
          <pre className="pre" data-testid="ruleset-body">
            {JSON.stringify(ruleset.body, null, 2)}
          </pre>
        </Card>
        <div className="stack">
          <Card title="Activation">
            <ActivateRuleset version={ruleset.version} active={ruleset.active} admin={me.operator.role === 'admin'} />
          </Card>
          <Card title="History">
            <DataTable
              rows={audit}
              rowKey={(row) => row.id}
              empty="No audit rows."
              columns={[
                { key: 'at', header: 'At', render: (row) => formatInstant(row.createdAt) },
                { key: 'action', header: 'Action', render: (row) => <Mono>{row.action}</Mono> },
                { key: 'actor', header: 'Actor', render: (row) => `${row.actorKind}${row.actorRef === null ? '' : `:${row.actorRef}`}` },
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
