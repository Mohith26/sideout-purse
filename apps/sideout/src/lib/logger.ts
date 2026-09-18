import { createLogger, type LogLevel, type Logger } from '@repo/logger';

let root: Logger | undefined;

/** The process logger. Resolved lazily so importing this module never reads the env. */
export function logger(level: LogLevel = 'info'): Logger {
  root ??= createLogger({ service: 'sideout-web', level });
  return root;
}
