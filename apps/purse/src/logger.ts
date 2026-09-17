/**
 * Structured JSON logging, one line per event, to stdout. This is the only file in Purse
 * allowed to write to the console (the ESLint `no-console` exemption is scoped to it).
 *
 * Every line carries `service`, `level`, `time`, `msg`, and whatever fields the caller
 * adds. Request-scoped loggers add `requestId`, which Sideout forwards on every call it
 * makes to Purse, so one request can be followed across the boundary (spec section 10).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that stamps every line with these fields in addition to its own. */
  child(fields: LogFields): Logger;
};

export type LoggerOptions = {
  service: string;
  level: LogLevel;
  /** Where lines go. Defaults to stdout; tests pass a collector. */
  write?: (line: string) => void;
};

/** Turn an unknown thrown value into loggable fields without leaking a stack to clients. */
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
    const record = {
      time: new Date().toISOString(),
      level,
      service: options.service,
      msg,
      ...bound,
      ...fields,
    };
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
