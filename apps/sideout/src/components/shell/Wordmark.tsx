import Link from 'next/link';

export function Wordmark() {
  return (
    <Link href="/" className="type-heading inline-flex items-center gap-2 text-text-primary" aria-label="Sideout home">
      <span aria-hidden="true" className="inline-block size-2.5 rounded-pill bg-volt" />
      Sideout
    </Link>
  );
}
