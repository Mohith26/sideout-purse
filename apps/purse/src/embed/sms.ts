import type { Logger } from '@repo/logger';

import type { SmsImplementation } from '../env';
import { EmbedError } from './errors';

/**
 * The embed sign-in's SMS seam, the same shape as Sideout's (`apps/sideout/src/server/auth/sms.ts`):
 * a real provider (Twilio, Telnyx, ...) plugs in here. `log` writes the message to the
 * structured log and tells the caller to echo the code to the browser, which the env
 * loader refuses in production; `none` is what production gets until a provider is
 * configured, and the sign-in flow reports `sms_unavailable`.
 */
export type SmsSender = {
  readonly name: SmsImplementation;
  /** Whether the code may be shown to the browser: only the log sender, only outside production. */
  readonly echoesCode: boolean;
  send(input: { to: string; body: string }): Promise<void>;
};

export function logSmsSender(log: Logger): SmsSender {
  return {
    name: 'log',
    echoesCode: true,
    send: async ({ to, body }) => {
      log.info('sms (log sender, not delivered)', { to, body });
      await Promise.resolve();
    },
  };
}

export const unavailableSmsSender: SmsSender = {
  name: 'none',
  echoesCode: false,
  send: () => Promise.reject(new EmbedError('sms_unavailable', 'No SMS provider is configured, so no sign-in code can be sent')),
};

export function createSmsSender(implementation: SmsImplementation, log: Logger): SmsSender {
  return implementation === 'log' ? logSmsSender(log) : unavailableSmsSender;
}
