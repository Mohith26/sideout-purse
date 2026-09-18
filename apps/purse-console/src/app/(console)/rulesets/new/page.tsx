import type { Metadata } from 'next';
import type { ConsoleMeResource, RulesetResource, RulesetSummaryResource } from '@purse/types';

import { PageHead } from '../../../../components/PageHead';
import { load } from '../../../../server/api';
import { NewRuleset } from './NewRuleset';

export const metadata: Metadata = { title: 'New ruleset version' };

/** A new version starts from the current (or a chosen) body with the version bumped; the API validates it against the schema before storing. */
export default async function NewRulesetPage({ searchParams }: { searchParams: Promise<{ from?: string }> }) {
  const { from } = await searchParams;
  const [{ rulesets }, me] = await Promise.all([load<{ rulesets: RulesetSummaryResource[] }>('/rulesets', '/rulesets/new'), load<ConsoleMeResource>('/auth/me')]);
  const source = rulesets.find((each) => each.version === from) ?? rulesets.find((each) => each.active) ?? rulesets[0];
  const body = source === undefined ? null : (await load<RulesetResource>(`/rulesets/${source.version}`)).body;
  return (
    <>
      <PageHead title="New ruleset version" crumbs={[{ label: 'Rulesets', href: '/rulesets' }, { label: 'New version' }]} lede={source === undefined ? 'No version to start from.' : `Starting from ${source.version}${source.active ? ' (active)' : ''}. Versions read YYYY.MM.n.`} />
      <NewRuleset initialBody={body} existing={rulesets.map((each) => each.version)} admin={me.operator.role === 'admin'} />
    </>
  );
}
