'use client';

import { CloseFlow as Flow } from '../../../../../../components/CloseFlow';

export function CloseFlow(props: { tenantId: string; contestId: string; asset: string; names: Record<string, string> }) {
  return <Flow {...props} />;
}
