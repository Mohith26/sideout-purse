import { Notice } from '@sideout/ui';
import type { ApiError } from '@purse/types';

/** A sealed API error, rendered in place: the type and code are the contract, the message is copy, the detail is shown when it carries something to act on. */
const TITLE_BY_TYPE: Record<ApiError['type'], string> = {
  invalid_request: 'Check the request',
  authentication_error: 'Sign in again',
  permission_error: 'Not allowed',
  not_eligible: 'Not eligible',
  insufficient_funds: 'Insufficient funds',
  invalid_state: 'Not in that state',
  conflict: 'Conflict',
  rate_limited: 'Slow down',
  internal_error: 'Something went wrong',
};

export function ErrorNotice({ error, title }: { error: ApiError; title?: string | undefined }) {
  const issues = Array.isArray(error.detail?.['issues']) ? (error.detail['issues'] as Array<{ path?: string; message?: string }>) : [];
  const reasons = Array.isArray(error.detail?.['reasons']) ? (error.detail['reasons'] as string[]) : [];
  return (
    <Notice tone="error" title={title ?? TITLE_BY_TYPE[error.type]}>
      <div className="stack" style={{ gap: 'var(--space-1)' }}>
        <span>
          <span className="so-mono">
            {error.type}/{error.code}
          </span>{' '}
          {error.message}
        </span>
        {issues.length === 0 ? null : (
          <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
            {issues.map((issue, index) => (
              <li key={`${issue.path ?? ''}-${index}`}>
                <span className="so-mono">{issue.path === '' || issue.path === undefined ? '(body)' : issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
        )}
        {reasons.length === 0 ? null : <span>Reasons: {reasons.join(', ')}</span>}
      </div>
    </Notice>
  );
}
