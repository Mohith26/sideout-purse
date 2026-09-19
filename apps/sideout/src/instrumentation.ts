/**
 * Next's instrumentation hook, run once when the server starts. The Node server checks
 * its environment before serving (`instrumentation-node.ts`); the edge runtime has no
 * process environment to check and is bundled without Node modules, which is why the
 * check lives in a file imported only under the Node runtime guard (Next's documented
 * pattern).
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    const { checkEnvironmentOrExit } = await import('./instrumentation-node');
    checkEnvironmentOrExit();
  }
}
