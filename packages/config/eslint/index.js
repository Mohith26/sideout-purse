// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import importX, { createNodeResolver } from 'eslint-plugin-import-x';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { consoleBoundary, embedBoundary, purseBoundary, sideoutBoundary, sideoutSdkGate } from './boundary.js';

/**
 * Paths ESLint never looks at. Migrations are generated SQL and JSON; build output and
 * caches are not source.
 */
export const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/out/**',
  '**/coverage/**',
  '**/drizzle/meta/**',
  '**/next-env.d.ts',
  '**/*.tsbuildinfo',
];

/**
 * The one place structured logs are allowed to reach stdout. Everything else must go
 * through `@repo/logger`, which is what makes request ids traceable across the service
 * boundary (system spec section 10).
 */
export const LOGGER_FILES = ['packages/logger/src/**/*.ts'];

/**
 * Root flat config for the monorepo.
 *
 * @param {{ repoRoot: string }} options `repoRoot` is the absolute path of the repository
 *   root; it anchors type-aware linting and the boundary path zones.
 * @returns {import('eslint').Linter.Config[]}
 */
export function defineConfig({ repoRoot }) {
  return [
    { name: 'repo/ignores', ignores: IGNORES },

    {
      // Plugins are registered once, for every file, so any later block can use their rules.
      name: 'repo/plugins',
      plugins: { 'import-x': importX },
    },

    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,

    {
      name: 'repo/typescript',
      files: ['**/*.{ts,tsx,mts,cts}'],
      languageOptions: {
        parserOptions: {
          // Every TypeScript file belongs to a project referenced from the root tsconfig;
          // a file outside all of them fails lint, which is the right signal.
          projectService: true,
          tsconfigRootDir: repoRoot,
        },
        globals: { ...globals.node },
      },
      settings: {
        // Resolves workspace packages through their `exports` (which point at TypeScript
        // source) and follows pnpm symlinks to real paths, which is what lets
        // `no-restricted-paths` see that `@purse/sdk` lives in packages/purse-sdk.
        'import-x/resolver-next': [
          createNodeResolver({
            extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'],
            conditionNames: ['types', 'import', 'default'],
          }),
        ],
      },
      rules: {
        // Section 7 of the system spec bans `any`, empty `catch`, and leftover console
        // output outright.
        'no-console': 'error',
        'no-empty': ['error', { allowEmptyCatch: false }],
        '@typescript-eslint/no-explicit-any': 'error',

        eqeqeq: ['error', 'always'],
        'no-var': 'error',
        'prefer-const': 'error',
        'object-shorthand': 'error',

        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/no-misused-promises': [
          'error',
          { checksVoidReturn: { attributes: false } },
        ],
        '@typescript-eslint/restrict-template-expressions': [
          'error',
          { allowNumber: true, allowBoolean: true },
        ],
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],

        'import-x/no-duplicates': 'error',
        'import-x/no-self-import': 'error',
        'import-x/first': 'error',
        'import-x/newline-after-import': 'error',
      },
    },

    {
      name: 'repo/javascript',
      files: ['**/*.{js,mjs,cjs}'],
      languageOptions: {
        ...tseslint.configs.disableTypeChecked.languageOptions,
        globals: { ...globals.node },
      },
      rules: {
        ...tseslint.configs.disableTypeChecked.rules,
        'no-console': 'error',
        'no-empty': ['error', { allowEmptyCatch: false }],
      },
    },

    {
      // The service worker is plain JavaScript served from public/ and runs in a worker, not Node.
      name: 'repo/service-worker',
      files: ['apps/sideout/public/sw.js'],
      languageOptions: { globals: { ...globals.serviceworker } },
    },

    {
      name: 'repo/logger-exemption',
      files: LOGGER_FILES,
      rules: { 'no-console': 'off' },
    },

    {
      name: 'repo/operator-cli',
      files: ['scripts/**/*.ts'],
      rules: {
        // The one non-logger exemption: root operator CLIs (db:setup) talk to a terminal,
        // not a log pipeline. App code, including the apps' own scripts, uses the logger.
        'no-console': 'off',
      },
    },

    {
      name: 'repo/tests',
      files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
      rules: {
        '@typescript-eslint/no-non-null-assertion': 'off',
        '@typescript-eslint/unbound-method': 'off',
      },
    },

    {
      name: 'repo/react',
      files: ['apps/sideout/**/*.{ts,tsx}', 'apps/purse-embed/**/*.{ts,tsx}', 'apps/purse-console/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
      plugins: { 'react-hooks': reactHooks },
      languageOptions: { globals: { ...globals.browser } },
      rules: {
        ...reactHooks.configs.recommended.rules,
      },
    },

    {
      name: 'repo/nextjs',
      files: ['apps/sideout/**/*.{ts,tsx}', 'apps/purse-embed/**/*.{ts,tsx}', 'apps/purse-console/**/*.{ts,tsx}'],
      plugins: { '@next/next': nextPlugin },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
      },
      settings: { next: { rootDir: [`${repoRoot}/apps/sideout`, `${repoRoot}/apps/purse-embed`, `${repoRoot}/apps/purse-console`] } },
    },

    sideoutBoundary(repoRoot),
    sideoutSdkGate(),
    purseBoundary(repoRoot),
    embedBoundary(repoRoot),
    consoleBoundary(repoRoot),
  ];
}
