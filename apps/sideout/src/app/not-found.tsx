import Link from 'next/link';
import { EmptyState, LinkButton } from '@sideout/ui';

export default function NotFound() {
  return (
    <EmptyState
      level={1}
      icon="circleDashed"
      title="No page here"
      body="The link may be old, or the event may not exist yet."
      action={
        <LinkButton component={Link} variant="primary" href="/">
          Back to live play
        </LinkButton>
      }
    />
  );
}
