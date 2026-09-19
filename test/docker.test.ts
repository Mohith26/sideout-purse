import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The container images (spec section 10: one Dockerfile per service, multi-stage,
 * non-root, with a health check; migrations on deploy that fail the deploy on error). The
 * shape is pinned here so a change that drops the privilege switch, the health check or
 * the migrate-before-serve order fails the build before it reaches the host.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

const SERVICES = [
  { name: 'purse', dockerfile: 'apps/purse/Dockerfile', entrypoint: 'apps/purse/docker-entrypoint.sh', port: 4000, migrates: true },
  { name: 'purse-console', dockerfile: 'apps/purse-console/Dockerfile', entrypoint: 'apps/purse-console/docker-entrypoint.sh', port: 4200, migrates: false },
  { name: 'sideout', dockerfile: 'apps/sideout/Dockerfile', entrypoint: 'apps/sideout/docker-entrypoint.sh', port: 3000, migrates: true },
  { name: 'pingpong', dockerfile: 'apps/pingpong/Dockerfile', entrypoint: 'apps/pingpong/docker-entrypoint.sh', port: 3100, migrates: true },
] as const;

describe('container images', () => {
  it.each(SERVICES)('$name: multi-stage, non-root, health-checked, built from the repository root', ({ dockerfile, port }) => {
    const text = read(dockerfile);
    const stages = [...text.matchAll(/^FROM .* AS (\w+)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(['base', 'build', 'deps', 'runtime']);
    expect(text).toMatch(/^USER node$/m);
    expect(text).toMatch(/^HEALTHCHECK /m);
    expect(text).toContain(`/health`);
    expect(text).toMatch(new RegExp(`^EXPOSE ${port}$`, 'm'));
    // Production dependencies come from a clean install, never from pruning the build stage in place.
    expect(text).toMatch(/pnpm install --frozen-lockfile --prod --filter/);
    expect(text).not.toMatch(/npm prune/);
    // No secret is baked in: the only build arguments are the sha, for the tenants the NEXT_PUBLIC_
    // values, and for Sideout the demo-accounts switch (a boolean the build inlines; docs/demo-accounts.md).
    const args = [...text.matchAll(/^ARG (\w+)/gm)].map((m) => m[1]);
    expect(args.every((arg) => arg === 'BUILD_SHA' || arg === 'DEMO_ACCOUNTS' || arg?.startsWith('NEXT_PUBLIC_'))).toBe(true);
  });

  it.each(SERVICES)('$name: the start command runs the migrations first and lets a failure fail the deploy', ({ entrypoint, migrates }) => {
    const text = read(entrypoint);
    expect(text).toMatch(/^set -eu$/m);
    expect(text).toMatch(/^exec node /m);
    if (migrates) {
      const migrate = text.indexOf('node dist/migrate.js');
      const serve = text.indexOf('exec node ');
      expect(migrate).toBeGreaterThan(-1);
      expect(migrate).toBeLessThan(serve);
    } else {
      expect(text).not.toContain('dist/migrate.js');
    }
  });

  it('the Purse server never holds the owner role: the entrypoint drops the migrator URL before serving', () => {
    const text = read('apps/purse/docker-entrypoint.sh');
    const migrate = text.indexOf('node dist/migrate.js');
    const unset = text.indexOf('unset PURSE_MIGRATOR_DATABASE_URL');
    const serve = text.indexOf('exec node dist/index.js');
    expect(migrate).toBeLessThan(unset);
    expect(unset).toBeLessThan(serve);
  });

  it('the demo reset job resets Purse before Sideout, refuses to run without the switch, and runs as node', () => {
    const run = read('docker/demo-reset/run.sh');
    expect(run).toMatch(/^set -eu$/m);
    expect(run).toContain('${DEMO_RESET:?');
    expect(run.indexOf('apps/purse && node dist/demo-reset.js')).toBeLessThan(run.indexOf('apps/sideout && node dist/demo-reset.js'));
    const dockerfile = read('docker/demo-reset/Dockerfile');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/next build/);
  });

  it('the build context leaves out environment files, dependencies, build output and the tests', () => {
    const lines = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    for (const entry of ['.git', 'node_modules', '**/node_modules', '.env', '.env.*', '**/.env', '**/.env.*', '!.env.example', '!**/.env.example', '**/dist', '**/.next', '**/test', '**/e2e', 'docs']) {
      expect(lines, entry).toContain(entry);
    }
  });

  /**
   * Building the images is the gate that catches what `pnpm build` on a checkout cannot
   * (below), so every image in the repository has to be in CI's matrix: a new service that
   * adds a Dockerfile and forgets the leg fails here rather than at the next deploy.
   */
  it('CI builds every image in the repository', async () => {
    const workflow = read('.github/workflows/ci.yml');
    const named = new Set([...workflow.matchAll(/^\s+dockerfile: (\S+)$/gm)].map((m) => m[1]));
    const dockerfiles: string[] = [];
    for await (const file of glob('{apps,docker}/*/Dockerfile', { cwd: ROOT })) dockerfiles.push(file);
    expect(dockerfiles.length).toBeGreaterThanOrEqual(5);
    for (const file of dockerfiles) {
      expect(named, `${file} is not built by the images job in .github/workflows/ci.yml`).toContain(file);
    }
    expect([...named].every((file) => dockerfiles.includes(file ?? ''))).toBe(true);
  });

  /**
   * A shipped source file that imports something `.dockerignore` drops builds on a full
   * checkout and fails inside the image, which is how the public `/docs` page's contract
   * fixtures reached a deploy (docs/decisions.md). The rule is now that shipped source
   * reaches into none of them at all — the fixtures live in
   * `apps/purse/src/docs/contract-fixtures.json` — so no `!` exception has to be kept in
   * step with an import. Only the excluded directories a source file can plausibly reach
   * into are checked, which is cheap and is the case that bit. CI builds every image
   * (`.github/workflows/ci.yml`), which catches the rest of the class.
   */
  it('the shipped source imports nothing the build context drops', async () => {
    const reached: string[] = [];
    for await (const file of glob('apps/*/src/**/*.{ts,tsx}', { cwd: ROOT })) {
      const source = readFileSync(path.join(ROOT, file), 'utf8');
      for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
        const specifier = match[1];
        if (specifier === undefined) continue;
        const resolved = path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, file)), specifier));
        // Only the directories `.dockerignore` drops wholesale, matched as directories:
        // `src/routes/docs.ts` is a module named docs, not the excluded `docs/` tree.
        const directories = resolved.split('/').slice(0, -1);
        if (directories.includes('test') || directories.includes('e2e') || directories[0] === 'docs') reached.push(`${file} -> ${resolved}`);
      }
    }
    expect(reached, 'shipped source imports a path .dockerignore drops from every image build context').toEqual([]);
  });
});
