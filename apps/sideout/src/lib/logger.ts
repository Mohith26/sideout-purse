/**
 * Structured JSON logging for Sideout's server side, one line per event, to stdout. This
 * is the only file in Sideout allowed to write to the console (the ESLint `no-console`
 * exemption is scoped to it).
 *
 * Request-scoped loggers carry `requestId`, the same value Sideout forwards to Purse as
 * `X-Request-Id`, so a Sideout request can be traced into its Purse calls (spec §10).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

export type LoggerOptions = {
  service: string;
  level: LogLevel;
  write?: (line: string) => void;
};

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      err: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.cause === undefined ? {} : { cause: describeCause(error.cause) }),
      },
    };
  }
  return { err: { message: String(error) } };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'object' && cause !== null) return JSON.stringify(cause, (_k, v: unknown) => serialise(v));
  return String(cause);
}

function serialise(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const threshold = LEVEL_RANK[options.level];
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });

  const emit = (level: LogLevel, msg: string, fields: LogFields | undefined): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const record = { time: new Date().toISOString(), level, service: options.service, msg, ...bound, ...fields };
    write(JSON.stringify(record, (_key, value: unknown) => serialise(value)));
  };

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

let root: Logger | undefined;

/** The process logger. Resolved lazily so importing this module never reads the env. */
export function logger(level: LogLevel = 'info'): Logger {
  root ??= createLogger({ service: 'sideout-web', level });
  return root;
}
