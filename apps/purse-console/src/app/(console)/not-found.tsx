import Link from 'next/link';
import { Notice } from '@sideout/ui';

export default function NotFound() {
  return (
    <div className="stack">
      <Notice tone="warning" title="Nothing here">
        No tenant, contest, account, entry or version by that id.
      </Notice>
      <div>
        <Link href="/contests" className="so-link">
          Back to contests
        </Link>
      </div>
    </div>
  );
}
