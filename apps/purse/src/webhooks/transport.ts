import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { ResolvedAddress } from './destination';

/**
 * How a webhook attempt leaves the process (docs/webhooks-security.md).
 *
 * `fetch` is deliberately not used here. This transport connects to the exact address
 * `destination.ts` approved — a custom `lookup` hands the socket that address and nothing
 * else, so the address that was classified is the address that is dialled and a second
 * DNS answer between the check and the connection changes nothing. TLS still uses the
 * hostname, so the certificate is validated against the name the tenant registered.
 *
 * It also bounds what a hostile or simply broken receiver can cost a dispatcher lease:
 * a connect timeout, a total timeout over the whole exchange, a cap on how much of the
 * response is read, and no redirect following at all (`node:http` never follows one; a
 * 3xx is reported as the non-2xx it is, so the retry schedule handles it and Purse never
 * dials a second, unchecked destination).
 */
export type TransportRequest = {
  url: URL;
  /** The address the destination check approved; the socket connects here and nowhere else. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  body: string;
};

export type TransportLimits = {
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  maxResponseBytes: number;
};

export type TransportResponse = { status: number };

export type WebhookTransport = (request: TransportRequest, limits: TransportLimits) => Promise<TransportResponse>;

export const DEFAULT_LIMITS: TransportLimits = { connectTimeoutMs: 5000, totalTimeoutMs: 10_000, maxResponseBytes: 64 * 1024 };

export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    readonly reason: 'connect_timeout' | 'timeout' | 'response_too_large' | 'network',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** One POST to the pinned address. Resolves with the status; rejects with a `TransportError`. */
export const nodeTransport: WebhookTransport = (request, limits) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const secure = request.url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;
    let settled = false;
    let connected = false;
    // Held rather than bound, so the timers armed below can abandon a request that is not built yet.
    const pending: { request?: ClientRequest } = {};

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      clearTimeout(connect);
      action();
    };
    const fail = (error: TransportError): void => {
      finish(() => {
        pending.request?.destroy();
        reject(error);
      });
    };

    const total = setTimeout(() => fail(new TransportError('timeout', `the receiver did not answer within ${String(limits.totalTimeoutMs)}ms`)), limits.totalTimeoutMs);
    const connect = setTimeout(() => {
      if (!connected) fail(new TransportError('connect_timeout', `the receiver did not accept a connection within ${String(limits.connectTimeoutMs)}ms`));
    }, limits.connectTimeoutMs);
    total.unref?.();
    connect.unref?.();

    const outbound = send(
      {
        protocol: request.url.protocol,
        hostname: request.url.hostname.replace(/^\[|\]$/g, ''),
        port: request.url.port === '' ? (secure ? 443 : 80) : Number.parseInt(request.url.port, 10),
        path: `${request.url.pathname}${request.url.search}`,
        method: 'POST',
        headers: { ...request.headers, 'content-length': String(Buffer.byteLength(request.body)) },
        // The socket is given the checked address; the name is still what TLS is verified against.
        lookup: (_hostname: string, options: LookupOptions, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) => {
          if (options.all === true) callback(null, [{ address: request.address.address, family: request.address.family }]);
          else callback(null, request.address.address, request.address.family);
        },
        // A fresh connection per attempt: no pooled socket can outlive the address that was checked.
        agent: false,
        setHost: true,
      },
      (response: IncomingMessage) => {
        connected = true;
        const status = response.statusCode ?? 0;
        let read = 0;
        response.on('data', (chunk: Buffer) => {
          read += chunk.length;
          // The body is never stored; it is read only far enough to free the socket.
          if (read > limits.maxResponseBytes) {
            response.destroy();
            fail(new TransportError('response_too_large', `the receiver answered with more than ${String(limits.maxResponseBytes)} bytes`));
          }
        });
        response.on('end', () => finish(() => resolve({ status })));
        response.on('error', (error: Error) => fail(new TransportError('network', error.message, { cause: error })));
      },
    );
    pending.request = outbound;
    outbound.on('socket', (socket) => {
      const mark = (): void => {
        connected = true;
        clearTimeout(connect);
      };
      if (secure) socket.on('secureConnect', mark);
      else socket.on('connect', mark);
    });
    outbound.on('error', (error: Error) => fail(new TransportError('network', error.message, { cause: error })));
    outbound.end(request.body);
  });
