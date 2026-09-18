import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The security check from spec section 8: no secret key in anything the browser can
 * load. The console has no key at all (it holds a session token in an HttpOnly cookie
 * and calls the API server-to-server), so the built client bundles, every file under
 * `.next/static`, must not contain `sk_`, the prefix every secret key starts with, nor
 * `whsec_`, nor a console session token. Runs after every build and as a test.
 */
export const FORBIDDEN: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'secret API key', pattern: /sk_(sandbox|live)_[A-Za-z0-9]{8,}/ },
  { name: 'secret key prefix', pattern: /\bsk_/ },
  { name: 'webhook signing secret', pattern: /whsec_[A-Za-z0-9_-]{8,}/ },
  { name: 'console session token', pattern: /cst_[A-Za-z0-9_-]{43}/ },
];

export type BundleFinding = { file: string; name: string };

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

/** Every finding in every file under `staticDir`; an empty list is a clean bundle. */
export function scanBundle(staticDir: string): BundleFinding[] {
  const files: string[] = [];
  walk(staticDir, files);
  const findings: BundleFinding[] = [];
  for (const file of files) {
    if (!/\.(js|mjs|css|html|txt|json|map)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) findings.push({ file: path.relative(staticDir, file), name });
    }
  }
  return findings;
}
