import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The secret key never reaches a browser (system spec section 2, rule 2): after `next
 * build`, every JavaScript file Next would serve to a browser is searched for a Purse
 * secret key, the variable that holds one, and a webhook signing secret. A hit fails the
 * build. Runs as the second half of `pnpm --filter @sideout/web build`.
 */
const FORBIDDEN = [
  { name: 'a Purse secret key', pattern: /sk_(sandbox|live)_[A-Za-z0-9]{32}/ },
  { name: 'the PURSE_SECRET_KEY variable', pattern: /PURSE_SECRET_KEY/ },
  { name: 'a webhook signing secret', pattern: /whsec_[A-Za-z0-9]{16,}/ },
  { name: 'the PURSE_WEBHOOK_SECRET variable', pattern: /PURSE_WEBHOOK_SECRET/ },
];

const root = path.resolve(import.meta.dirname, '..', '.next', 'static');

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
