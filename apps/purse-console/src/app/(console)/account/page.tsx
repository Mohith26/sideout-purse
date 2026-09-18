import type { Metadata } from 'next';
import { Card, KeyValue, Mono } from '@sideout/ui';
import type { ConsoleMeResource } from '@purse/types';

import { PageHead } from '../../../components/PageHead';
import { StateChip } from '../../../components/StateChip';
import { formatInstant } from '../../../lib/format';
import { load } from '../../../server/api';
import { PasswordForm } from './PasswordForm';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const me = await load<ConsoleMeResource>('/auth/me', '/account');
  return (
    <>
      <PageHead title="Account" lede="Your console account. Changing the password signs out every other session." />
      <div className="grid grid--two">
        <Card title="Operator">
          <KeyValue
            items={[
              { key: 'Email', value: me.operator.email },
              { key: 'Role', value: <StateChip value={me.operator.role} /> },
              { key: 'Id', value: <Mono>{me.operator.id}</Mono> },
              { key: 'Session', value: <Mono>{me.sessionId}</Mono> },
              { key: 'Session expires', value: formatInstant(me.expiresAt) },
              { key: 'Since', value: formatInstant(me.operator.createdAt) },
            ]}
          />
        </Card>
        <Card title="Change password">
          <PasswordForm />
        </Card>
      </div>
    </>
  );
}
