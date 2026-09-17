import path from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Acceptance criterion 12: Sideout imports nothing from Purse but `@purse/sdk` and
 * `@purse/types`, enforced by lint. The fixtures below are linted as if they lived inside
 * each app (the file path decides which boundary config applies) and the specific rule
 * that must fire is asserted by id, so a loosened config cannot pass by accident.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

type Violation = { ruleId: string | null; message: string };

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.js'),
    // The fixtures never touch disk, so the type-aware parser cannot place them in a
    // project. The boundary rules need no type information; switch it off for fixtures
    // only and leave the real config otherwise untouched.
    overrideConfig: [{ files: ['**/*-fixture.ts'], ...tseslint.configs.disableTypeChecked }],
  });
});

async function lint(virtualPath: string, code: string): Promise<Violation[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, virtualPath) });
  if (result === undefined) throw new Error('ESLint returned no result');
  return result.messages.map((m) => ({ ruleId: m.ruleId, message: m.message }));
}

const ruleIds = (violations: Violation[]) => violations.map((v) => v.ruleId);

describe('Sideout → Purse', () => {
  const file = 'apps/sideout/src/boundary-fixture.ts';

  it('rejects a relative import into apps/purse by resolved path', async () => {
    const violations = await lint(file, "import { createApp } from '../../purse/src/app';\ncreateApp;\n");
    expect(ruleIds(violations)).toContain('import-x/no-restricted-paths');
    expect(violations.find((v) => v.ruleId === 'import-x/no-restricted-paths')?.message).toMatch(/@purse\/sdk and @purse\/types/);
  });

  it('rejects any @purse/* package other than sdk and types', async () => {
    const violations = await lint(file, "import { env } from '@purse/api';\nenv;\n");
    expect(ruleIds(violations)).toContain('no-restricted-imports');
  });

  it('rejects reaching into the internals of the allowed packages', async () => {
    const deep = await lint(file, "import { SDK_VERSION } from '@purse/sdk/src/version';\nSDK_VERSION;\n");
    expect(ruleIds(deep)).toContain('no-restricted-imports');

    const relative = await lint(file, "import { SDK_VERSION } from '../../../packages/purse-sdk/src/version';\nSDK_VERSION;\n");
    expect(ruleIds(relative)).toContain('import-x/no-restricted-paths');
    expect(ruleIds(relative)).toContain('no-restricted-imports');
  });

  it('allows the public entries of @purse/sdk and @purse/types', async () => {
    const violations = await lint(
      file,
      "import { Purse } from '@purse/sdk';\nimport { REQUEST_ID_HEADER } from '@purse/types';\nPurse;\nREQUEST_ID_HEADER;\n",
    );
    expect(ruleIds(violations).filter((id) => id === 'no-restricted-imports' || id === 'import-x/no-restricted-paths')).toEqual([]);
  });
});

describe('Purse → Sideout', () => {
  const file = 'apps/purse/src/boundary-fixture.ts';

  it('rejects @sideout/ui and any @sideout/* package', async () => {
    const violations = await lint(file, "import { Button } from '@sideout/ui';\nButton;\n");
    expect(ruleIds(violations)).toContain('no-restricted-imports');
    expect(ruleIds(violations)).toContain('import-x/no-restricted-paths');
  });

  it('rejects a relative import into apps/sideout by resolved path', async () => {
    const violations = await lint(file, "import { middleware } from '../../sideout/src/middleware';\nmiddleware;\n");
    expect(ruleIds(violations)).toContain('import-x/no-restricted-paths');
    expect(violations.find((v) => v.ruleId === 'import-x/no-restricted-paths')?.message).toMatch(/Purse must not import from Sideout/);
  });

  it('allows Purse to import its own shared packages', async () => {
    const violations = await lint(file, "import { newId } from '@repo/ids';\nimport { SDK_VERSION } from '@purse/sdk';\nnewId;\nSDK_VERSION;\n");
    expect(ruleIds(violations).filter((id) => id === 'no-restricted-imports' || id === 'import-x/no-restricted-paths')).toEqual([]);
  });
});

describe('repository-wide rules from spec section 7', () => {
  it('no-console, no-explicit-any and empty catch are errors in app code', async () => {
    const violations = await lint(
      'apps/purse/src/quality-fixture.ts',
      "export function f(x: any) {\n  try {\n    console.log(x);\n  } catch {}\n}\n",
    );
    expect(ruleIds(violations)).toEqual(expect.arrayContaining(['no-console', '@typescript-eslint/no-explicit-any', 'no-empty']));
    expect(violations.every((v) => v.ruleId !== null)).toBe(true);
  });
});
