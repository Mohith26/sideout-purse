import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifyWebhook } from '@purse/sdk';
import { WEBHOOK_SIGNATURE_HEADER, type WebhookEvent } from '@purse/types';

/**
 * A sample receiver, the one a partner would write with `@purse/sdk`: it verifies the
 * signature over the raw body against its secret and the clock it is given, dedupes on
 * the event id, and records what it saw. It can be taken down (the port refuses
 * connections), made to fail (500), or made slow (never answers), which is how the demo
 * test walks the retry schedule.
 */
export type ReceiverMode = 'up' | 'failing' | 'hanging';

export type Received = { eventId: string; type: string; deliveryHeader: string | null; at: number };

export class SampleReceiver {
  private server: Server | undefined;
  private port = 0;
  mode: ReceiverMode = 'up';
  secret: string;
  readonly received: Received[] = [];
  readonly rejected: Array<{ reason: string; at: number }> = [];
  readonly seen = new Set<string>();
  duplicates = 0;
  requests = 0;

  constructor(
    secret: string,
    private readonly clock: () => Date,
  ) {
    this.secret = secret;
  }

  /** Listen on a random loopback port; returns the URL to register with Purse. */
  async start(): Promise<string> {
    if (this.server !== undefined) return this.url;
    const server = createServer((request, response) => {
      this.requests += 1;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        void this.handle(rawBody, request.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string | undefined, request.headers['purse-delivery-id'] as string | undefined).then((status) => {
          if (status === undefined) return;
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: status < 300 }));
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this.url;
  }

  /** Close the port: every attempt is refused until `start` is called again on the same port. */
  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/hooks/purse`;
  }

  private async handle(rawBody: string, header: string | undefined, deliveryHeader: string | undefined): Promise<number | undefined> {
    if (this.mode === 'hanging') return undefined;
    if (this.mode === 'failing') return 500;
    const verdict = await verifyWebhook(rawBody, header, this.secret, { now: this.clock().getTime() });
    if (!verdict.ok) {
      this.rejected.push({ reason: verdict.reason, at: this.clock().getTime() });
      return 401;
    }
    const event = JSON.parse(rawBody) as WebhookEvent;
    if (this.seen.has(event.id)) {
      // Idempotent: the same event again is acknowledged and not re-processed.
      this.duplicates += 1;
      return 200;
    }
    this.seen.add(event.id);
    this.received.push({ eventId: event.id, type: event.type, deliveryHeader: deliveryHeader ?? null, at: this.clock().getTime() });
    return 200;
  }
}
