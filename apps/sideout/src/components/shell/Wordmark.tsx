import Link from 'next/link';

import { Volleyball } from '../art/Volleyball';

/**
 * The wordmark. The volt dot the platform's shell uses is a volleyball here: the same one
 * the bracket draws on a bye and the empty states stand on, so the mark and the art are
 * one drawing rather than a logo beside some decoration.
 */
export function Wordmark() {
  return (
    <Link href="/" className="type-heading inline-flex items-center gap-2 text-text-primary" aria-label="Sideout home">
      <Volleyball size={22} />
      Sideout
    </Link>
  );
}
