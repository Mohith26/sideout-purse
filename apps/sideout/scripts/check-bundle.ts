import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The secret key never reaches a browser (system spec section 2, rule 2): after `next
 * build`, every JavaScript file Next would serve to a browser is searched for a Purse
 * secret key, the variable that holds one, and a webhook signing secret. A hit fails the
 * build. Runs as the second half of `pnpm --filter @sideout/web build`.
 *
 * The same pass reads the build's route manifest: a production build must not contain
 * `/api/dev/login` (the dev-only sign-in, `route.dev.ts`, listed as a page extension only
 * outside production; docs/decisions.md, phase 6 and 9). A build that carries it fails
 * here rather than reaching a host.
 */
const FORBIDDEN = [
  { name: 'a Purse secret key', pattern: /sk_(sandbox|live)_[A-Za-z0-9]{32}/ },
  { name: 'the PURSE_SECRET_KEY variable', pattern: /PURSE_SECRET_KEY/ },
  { name: 'a webhook signing secret', pattern: /whsec_[A-Za-z0-9]{16,}/ },
  { name: 'the PURSE_WEBHOOK_SECRET variable', pattern: /PURSE_WEBHOOK_SECRET/ },
];

const root = path.resolve(import.meta.dirname, '..', '.next', 'static');
const routeManifest = path.resolve(import.meta.dirname, '..', '.next', 'app-path-routes-manifest.json');
/** Routes that must never exist in a production build. */
const FORBIDDEN_ROUTES = ['/api/dev/login'];

// A build-step script reporting to the terminal: the one place output is meant for a person, not a log pipeline.
/* eslint-disable no-console */

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
}

let files: string[];
try {
  files = walk(root);
} catch (error) {
  console.error(`check-bundle: cannot read ${root}: ${error instanceof Error ? error.message : String(error)}. Run \`next build\` first.`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`check-bundle: no client bundles under ${root}`);
  process.exit(1);
}

const hits: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { name, pattern } of FORBIDDEN) {
    if (pattern.test(text)) hits.push(`${path.relative(root, file)}: contains ${name}`);
  }
}
if (hits.length > 0) {
  console.error(`check-bundle: the client bundle leaks a server secret:\n  ${hits.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-bundle: ${files.length} client bundle file(s) clean of secret keys`);

let routes: Record<string, string>;
try {
  routes = JSON.parse(readFileSync(routeManifest, 'utf8')) as Record<string, string>;
} catch (error) {
  console.error(`check-bundle: cannot read ${routeManifest}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// `next build` always builds for production (it sets NODE_ENV itself), so the manifest of any build must be free of these.
const built = new Set(Object.values(routes));
const forbidden = FORBIDDEN_ROUTES.filter((route) => built.has(route));
if (forbidden.length > 0) {
  console.error(`check-bundle: the production build carries a development-only route: ${forbidden.join(', ')}`);
  process.exit(1);
}
console.log(`check-bundle: ${built.size} routes, none development-only`);
