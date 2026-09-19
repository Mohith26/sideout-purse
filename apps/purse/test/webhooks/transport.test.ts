import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeTransport, TransportError, type TransportLimits } from '../../src/webhooks';

/**
 * How an attempt leaves the process (`src/webhooks/transport.ts`): it connects to the
 * address the destination check approved and to no other, it never follows a redirect,
 * and neither a receiver that hangs nor one that answers with a river of bytes can hold a
 * dispatcher lease open.
 */
const LIMITS: TransportLimits = { connectTimeoutMs: 500, totalTimeoutMs: 800, maxResponseBytes: 1024 };

describe('the webhook transport', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ port: number; seen: IncomingMessage[] }> {
    const seen: IncomingMessage[] = [];
    const server = createServer((request, response) => {
      seen.push(request);
      request.resume();
      handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  const post = async (url: string, address = '127.0.0.1', limits: TransportLimits = LIMITS) =>
    nodeTransport({ url: new URL(url), address: { address, family: 4 }, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }, limits);

  it('connects to the pinned address, not to whatever the hostname would resolve to', async () => {
    const { port, seen } = await listen((_request, response) => {
      response.writeHead(204).end();
    });
    // The name never resolves; only the pinned address can have carried this request.
    const response = await post(`http://pinned.invalid:${String(port)}/hooks`);
    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
    // The Host header still names the destination, so a virtual host routes it as the tenant meant.
    expect(seen[0]?.headers.host).toBe(`pinned.invalid:${String(port)}`);
    expect(seen[0]?.method).toBe('POST');
  });

  it('reports a redirect as the non-2xx it is and never dials the second destination', async () => {
    const second = await listen((_request, response) => {
      response.writeHead(200).end();
    });
    const first = await listen((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${String(second.port)}/elsewhere` }).end();
    });
    const response = await post(`http://127.0.0.1:${String(first.port)}/hooks`);
    expect(response.status).toBe(302);
    expect(second.seen).toHaveLength(0);
  });

  it('gives up on a receiver that never answers, well inside the lease', async () => {
    const { port } = await listen(() => {
      // Accept the connection and say nothing at all.
    });
    const started = Date.now();
    const error = await post(`http://127.0.0.1:${String(port)}/hooks`).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(LIMITS.totalTimeoutMs + 1500);
  });

  it('gives up on a receiver that accepts no connection', async () => {
    // A port nothing listens on: the connection is refused rather than hanging.
    const { port } = await listen(() => undefined);
    await new Promise<void>((resolve) => {
      const server = servers.splice(0, 1)[0];
      server?.close(() => resolve());
    });
    const error = await post(`http://127.0.0.1:${String(port)}/hooks`).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).reason).toBe('network');
  });

  it('stops reading a receiver that answers with more than the cap', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const chunk = 'x'.repeat(4096);
      for (let index = 0; index < 32; index += 1) response.write(chunk);
      response.end();
    });
    const error = await post(`http://127.0.0.1:${String(port)}/hooks`).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).reason).toBe('response_too_large');
  });

  it('reads a small response and reports its status', async () => {
    const { port } = await listen((_request, response) => {
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    expect(await post(`http://127.0.0.1:${String(port)}/hooks`)).toEqual({ status: 202 });
  });
});
