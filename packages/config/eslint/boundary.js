// @ts-check
/**
 * The tenant/Purse import boundary (system spec section 2, "the four rules", and
 * decision D1). The apps live in one repository for velocity, so the boundary is
 * enforced by tooling: a tenant (Sideout, and since stretch item 4 the ping-pong ladder)
 * may reach Purse only through the published packages `@purse/sdk` and `@purse/types`,
 * and Purse may never reach into a tenant. The same rule, parameterised by the tenant's
 * directory, protects both consumers (`tenantBoundary`, `tenantSdkGate`).
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

/** @param {string} tenant the product's name, for the message */
const tenantMessage = (tenant) => `${tenant} may import from Purse only through @purse/sdk and @purse/types (system spec §2 rule 1, decision D1).`;

const PURSE_MESSAGE =
  'Purse must not import from Sideout or any other tenant; the platform knows nothing about its tenants’ code (system spec §2).';

const INTERNALS_MESSAGE =
  'Import the public entry of @purse/sdk or @purse/types, never a path inside the package.';

/**
 * @param {string} gate the one component, relative to the app, that mounts the SDK
 * @param {string} hook what everything else reaches Purse through
 */
const sdkGateMessage = (gate, hook) => `Only ${gate} mounts @purse/sdk flows in the browser (spec 4.8, 5.3); everything else reaches Purse through ${hook}.`;

/**
 * The tenants: every product built on Purse in this repository. Adding one is a row here
 * plus its blocks in `index.js`; `test/boundary.test.ts` drives the rule for each.
 *
 * @typedef {{ name: string, dir: string, gate: string, hook: string }} Tenant
 * @type {readonly Tenant[]}
 */
export const TENANTS = [
  { name: 'Sideout', dir: 'apps/sideout', gate: 'src/components/purse/PurseGate.tsx', hook: 'usePurse()' },
  { name: 'Ping-pong', dir: 'apps/pingpong', gate: 'src/components/PurseFrame.tsx', hook: '<PurseFrame>' },
];

/**
 * The `no-restricted-imports` patterns every tenant file gets; the SDK gate block repeats
 * them and adds its own.
 *
 * @param {string} message the tenant's message
 */
const tenantImportPatterns = (message) => [
  {
    group: ['@purse/*', '!@purse/sdk', '!@purse/types'],
    message,
  },
  {
    group: ['@purse/sdk/*', '@purse/types/*'],
    message: INTERNALS_MESSAGE,
  },
  {
    group: ['**/apps/purse', '**/apps/purse/**', '**/packages/purse-*', '**/packages/purse-*/**'],
    message,
  },
];
/** File globs that count as "Purse" for the boundary rule. */
export const PURSE_FILES = ['apps/purse/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
/** Every tenant's globs, for the Purse-side rules: Purse (and its embed and console) import nothing of any tenant. */
const TENANT_GLOBS = TENANTS.flatMap((t) => [`**/${t.dir}`, `**/${t.dir}/**`]);
/** A tenant's package by its `@<tenant>/*` scope: `@sideout/web`, `@pingpong/web`. `@sideout/ui` is the shared design system and is not a tenant's code. */
const TENANT_PACKAGE_GLOBS = ['@sideout/*', '!@sideout/ui', '@pingpong/*'];
/** The Purse embed app: Purse's, so it never reaches Sideout, but it renders on the shared design system. */
export const EMBED_FILES = ['apps/purse-embed/**/*.{ts,tsx,js,jsx,mjs,cjs}'];
/** The Purse operator console: the same rule as the embed, and it speaks to the API over HTTP (`/console`) only. */
export const CONSOLE_FILES = ['apps/purse-console/**/*.{ts,tsx,js,jsx,mjs,cjs}'];

/**
 * Rules applied to files under a tenant's directory: nothing of Purse's but the two
 * public packages, and nothing inside them. A tenant that also imports another tenant is
 * refused too: the products know each other only through Purse.
 *
 * @param {string} repoRoot absolute path of the repository root, used as `basePath`
 *   for the path zones so the rule does not depend on the process cwd
 * @param {Tenant} tenant
 * @returns {import('eslint').Linter.Config}
 */
export function tenantBoundary(repoRoot, tenant) {
  const message = tenantMessage(tenant.name);
  const others = TENANTS.filter((t) => t.dir !== tenant.dir);
  const otherMessage = `${tenant.name} must not import another tenant’s code; products on Purse know each other only through the platform.`;
  return {
    name: `boundary/${tenant.dir.replace('apps/', '')}`,
    files: [`${tenant.dir}/**/*.{ts,tsx,js,jsx,mjs,cjs}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...tenantImportPatterns(message),
            ...(others.length === 0 ? [] : [{ group: others.flatMap((t) => [`**/${t.dir}`, `**/${t.dir}/**`]), message: otherMessage }]),
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            { target: `./${tenant.dir}`, from: './apps/purse', message },
            {
              target: `./${tenant.dir}`,
              from: './packages/purse-sdk',
              except: ['./src/index.ts'],
              message: INTERNALS_MESSAGE,
            },
            {
              target: `./${tenant.dir}`,
              from: './packages/purse-types',
              except: ['./src/index.ts'],
              message: INTERNALS_MESSAGE,
            },
            ...others.map((t) => ({ target: `./${tenant.dir}`, from: `./${t.dir}`, message: otherMessage })),
          ],
        },
      ],
    },
  };
}

/**
 * Rules applied to a tenant's browser-facing files (pages, components, browser helpers):
 * `@purse/sdk` is mounted by one component and nowhere else (spec 4.8, 5.3). Server
 * modules may use the SDK's server helpers. `test/boundary.test.ts` asserts the rule
 * fires for a component and stays quiet for the gate and for a server module.
 *
 * @param {Tenant} tenant
 * @returns {import('eslint').Linter.Config}
 */
export function tenantSdkGate(tenant) {
  return {
    name: `boundary/${tenant.dir.replace('apps/', '')}-sdk-gate`,
    files: [`${tenant.dir}/src/app/**/*.{ts,tsx}`, `${tenant.dir}/src/components/**/*.{ts,tsx}`, `${tenant.dir}/src/lib/**/*.{ts,tsx}`],
    ignores: [`${tenant.dir}/${tenant.gate}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@purse/sdk', message: sdkGateMessage(tenant.gate.replace('src/', ''), tenant.hook) }],
          patterns: tenantImportPatterns(tenantMessage(tenant.name)),
        },
      ],
    },
  };
}

const SIDEOUT = TENANTS[0];

/**
 * Rules applied to files under `apps/sideout`: `tenantBoundary` for the first tenant.
 *
 * @param {string} repoRoot absolute path of the repository root
 * @returns {import('eslint').Linter.Config}
 */
export function sideoutBoundary(repoRoot) {
  if (SIDEOUT === undefined) throw new Error('TENANTS is empty');
  return tenantBoundary(repoRoot, SIDEOUT);
}

/**
 * Rules applied to Sideout's browser-facing files: `tenantSdkGate` for the first tenant.
 *
 * @returns {import('eslint').Linter.Config}
 */
export function sideoutSdkGate() {
  if (SIDEOUT === undefined) throw new Error('TENANTS is empty');
  return tenantSdkGate(SIDEOUT);
}

/**
 * The boundary blocks of every tenant, for the root config.
 *
 * @param {string} repoRoot absolute path of the repository root
 * @returns {import('eslint').Linter.Config[]}
 */
export function tenantBoundaries(repoRoot) {
  return TENANTS.flatMap((tenant) => [tenantBoundary(repoRoot, tenant), tenantSdkGate(tenant)]);
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
            { group: ['@sideout/*', '@pingpong/*'], message: PURSE_MESSAGE },
            { group: TENANT_GLOBS, message: PURSE_MESSAGE },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            ...TENANTS.map((t) => ({ target: './apps/purse', from: `./${t.dir}`, message: PURSE_MESSAGE })),
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
            { group: TENANT_PACKAGE_GLOBS, message: PURSE_MESSAGE },
            { group: TENANT_GLOBS, message: PURSE_MESSAGE },
            { group: ['**/apps/purse', '**/apps/purse/**', '@purse/api'], message: 'The embed app reaches the Purse API over HTTP (/v1/embed), never through its source.' },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            ...TENANTS.map((t) => ({ target: './apps/purse-embed', from: `./${t.dir}`, message: PURSE_MESSAGE })),
            { target: './apps/purse-embed', from: './apps/purse', message: 'The embed app reaches the Purse API over HTTP (/v1/embed), never through its source.' },
          ],
        },
      ],
    },
  };
}

/**
 * Rules applied to files under `apps/purse-console`: like the embed, a Purse app on the
 * shared design system that reaches the API only over HTTP (its `/console` routes), never
 * through the API's source, and never anything of Sideout.
 *
 * @param {string} repoRoot absolute path of the repository root
 * @returns {import('eslint').Linter.Config}
 */
export function consoleBoundary(repoRoot) {
  const message = 'The console app reaches the Purse API over HTTP (/console), never through its source.';
  return {
    name: 'boundary/purse-console',
    files: CONSOLE_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: TENANT_PACKAGE_GLOBS, message: PURSE_MESSAGE },
            { group: TENANT_GLOBS, message: PURSE_MESSAGE },
            { group: ['**/apps/purse', '**/apps/purse/**', '@purse/api', '@purse/embed'], message },
          ],
        },
      ],
      'import-x/no-restricted-paths': [
        'error',
        {
          basePath: repoRoot,
          zones: [
            ...TENANTS.map((t) => ({ target: './apps/purse-console', from: `./${t.dir}`, message: PURSE_MESSAGE })),
            { target: './apps/purse-console', from: './apps/purse', message },
            { target: './apps/purse-console', from: './apps/purse-embed', message },
          ],
        },
      ],
    },
  };
}
