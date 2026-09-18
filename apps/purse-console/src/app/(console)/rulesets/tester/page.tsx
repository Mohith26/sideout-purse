import type { Metadata } from 'next';
import type { RulesetSummaryResource } from '@purse/types';

import { PageHead } from '../../../../components/PageHead';
import { RulesetTester } from '../../../../components/RulesetTester';
import { load } from '../../../../server/api';

export const metadata: Metadata = { title: 'Ruleset tester' };

/** "What would this decide": the pure evaluator over a sample user, nothing persisted. */
export default async function TesterPage({ searchParams }: { searchParams: Promise<{ version?: string }> }) {
  const { version } = await searchParams;
  const { rulesets } = await load<{ rulesets: RulesetSummaryResource[] }>('/rulesets', '/rulesets/tester');
  return (
    <>
      <PageHead title="Ruleset tester" crumbs={[{ label: 'Rulesets', href: '/rulesets' }, { label: 'Tester' }]} lede="Runs the evaluator server-side against the sample below and shows the sealed decision. No decision is recorded, no user is touched." />
      <RulesetTester versions={rulesets.map((each) => ({ version: each.version, active: each.active }))} initialVersion={rulesets.some((each) => each.version === version) ? version : undefined} />
    </>
  );
}
