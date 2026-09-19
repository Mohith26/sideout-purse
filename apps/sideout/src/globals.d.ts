// Global stylesheet imports have no exports; TypeScript 6 checks side-effect imports resolve.
declare module '*.css';

declare namespace NodeJS {
  // Interface merging is the only way to augment ProcessEnv.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface ProcessEnv {
    /** The public demo's sign-in switch (`src/env.ts`, `docs/demo-accounts.md`); read literally in `next.config.ts`. */
    readonly DEMO_ACCOUNTS?: string;
    /** Derived from `DEMO_ACCOUNTS` by `next.config.ts` and inlined by `next build`; `src/env.ts` reads it literally so Next can replace it. */
    readonly NEXT_PUBLIC_DEMO_ACCOUNTS?: string;
  }
}
