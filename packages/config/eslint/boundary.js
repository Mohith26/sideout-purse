// @ts-check
/**
 * The Sideout/Purse import boundary (system spec section 2, "the four rules", and
 * decision D1). The two apps live in one repository for velocity, so the boundary is
 * enforced by tooling: Sideout may reach Purse only through the published packages
 * `@purse/sdk` and `@purse/types`, and Purse may never reach into Sideout.
 *
 * Two rules cooperate because they see different things:
 *
 * - `no-restricted-imports` matches the raw import specifier, so it catches bare package
 *   imports such as `@purse/api` or `@purse/sdk/src/internal` regardless of whether they
 *   resolve.
 * - `import-x/no-restricted-paths` resolves the specifier to a file on disk, so it
 *   catches relative escapes such as `../../../purse/src/app` that never mention the
 *   package name.
 *
 * `test/boundary.test.ts` at the repository root runs ESLint against fixtures that violate each
 * direction and asserts these exact rule ids fire.
 */

const SIDEOUT_MESSAGE =
  'Sideout may import from Purse only through @purse/sdk and @purse/types (system spec §2 rule 1, decision D1).';

const PURSE_MESSAGE =
  'Purse must not import from Sideout; the platform knows nothing about its tenants’ code (system spec §2).';

const INTERNALS_MESSAGE =
  'Import the public entry of @purse/sdk or @purse/types, never a path inside the package.';

/** File globs that count as "Sideout" and "Purse" for the boundary rule. */
export const SIDEOUT_FILES = ['apps/sideout/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
export const PURSE_FILES = ['apps/purse/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
/** The Purse embed app: Purse's, so it never reaches Sideout, but it renders on the shared design system. */
export const EMBED_FILES = ['apps/purse-embed/**/*.{ts,tsx,js,jsx,mjs,cjs}'];

/**
 * Rules applied to files under `apps/sideout`.
 *
 * @param {string} repoRoot absolute path of the repository root, used as `basePath`
 *   for the path zones so the rule does not depend on the process cwd
 * @returns {import('eslint').Linter.Config}
 */
export function sideoutBoundary(repoRoot) {
  return {
    name: 'boundary/sideout',
    files: SIDEOUT_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@purse/*', '!@purse/sdk', '!@purse/types'],
              message: SIDEOUT_MESSAGE,
            },
            {
              group: ['@purse/sdk/*', '@purse/types/*'],
              message: INTERNALS_MESSAGE,
            },
            {
              group: ['**/apps/purse', '**/apps/purse/**', '**/packages/purse-*', '**/packages/purse-*/**'],
              message: SIDEOUT_MESSAGE,
            },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            { target: './apps/sideout', from: './apps/purse', message: SIDEOUT_MESSAGE },
            {
              target: './apps/sideout',
              from: './packages/purse-sdk',
              except: ['./src/index.ts'],
              message: INTERNALS_MESSAGE,
            },
            {
              target: './apps/sideout',
              from: './packages/purse-types',
              except: ['./src/index.ts'],
              message: INTERNALS_MESSAGE,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Rules applied to files under `apps/purse`.
 *
 * @param {string} repoRoot absolute path of the repository root
 * @returns {import('eslint').Linter.Config}
 */
export function purseBoundary(repoRoot) {
  return {
    name: 'boundary/purse',
    files: PURSE_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@sideout/*'], message: PURSE_MESSAGE },
            { group: ['**/apps/sideout', '**/apps/sideout/**'], message: PURSE_MESSAGE },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            { target: './apps/purse', from: './apps/sideout', message: PURSE_MESSAGE },
            { target: './apps/purse', from: './packages/ui', message: PURSE_MESSAGE },
          ],
        },
      ],
    },
  };
}

/**
 * Rules applied to files under `apps/purse-embed`: the embed is a Purse app (it knows
 * nothing of Sideout) that talks to the API only over HTTP, never through its source, and
 * consumes `@sideout/ui`, the one package the spec shares across every app (section 6).
 *
 * @param {string} repoRoot absolute path of the repository root
 * @returns {import('eslint').Linter.Config}
 */
export function embedBoundary(repoRoot) {
  return {
    name: 'boundary/purse-embed',
    files: EMBED_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@sideout/*', '!@sideout/ui'], message: PURSE_MESSAGE },
            { group: ['**/apps/sideout', '**/apps/sideout/**', '**/apps/purse', '**/apps/purse/**', '@purse/api'], message: 'The embed app reaches the Purse API over HTTP (/v1/embed), never through its source.' },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            { target: './apps/purse-embed', from: './apps/sideout', message: PURSE_MESSAGE },
            { target: './apps/purse-embed', from: './apps/purse', message: 'The embed app reaches the Purse API over HTTP (/v1/embed), never through its source.' },
          ],
        },
      ],
    },
  };
}
