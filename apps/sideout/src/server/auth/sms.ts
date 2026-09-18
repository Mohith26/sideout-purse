import type { Logger } from '@repo/logger';

/**
 * The SMS seam. `SmsSender` is where a real provider (Twilio, Telnyx, ...) plugs in; the
 * captain chooses one before public deploy (docs/decisions.md). Until then:
 *
 * - `logSmsSender` writes the message to the structured log. The env loader refuses it in
 *   production, so codes can never reach a production log.
 * - `unavailableSmsSender` is what production gets with no provider configured: request
 *   code fails with `sms_unavailable` and no code is issued.
 */
export type SmsSender = {
  readonly name: 'log' | 'unavailable';
  send(input: { to: string; body: string }): Promise<void>;
};

export class SmsUnavailableError extends Error {
  override readonly name = 'SmsUnavailableError';
  constructor() {
    super('No SMS provider is configured, so no code can be sent.');
  }
}

export function logSmsSender(log: Logger): SmsSender {
  return {
    name: 'log',
    send: async ({ to, body }) => {
      log.info('sms (log sender, not delivered)', { to, body });
      await Promise.resolve();
    },
  };
}

export const unavailableSmsSender: SmsSender = {
  name: 'unavailable',
  send: () => Promise.reject(new SmsUnavailableError()),
};
