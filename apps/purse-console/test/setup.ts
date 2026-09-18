import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Component tests render client components under jsdom with the console's fetch
 * replaced per test (`mockApi`), so `/api/purse/*` answers whatever the test needs and
 * nothing reaches a network. `next/navigation` is stubbed: a component's `router.refresh`
 * is a no-op here.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
