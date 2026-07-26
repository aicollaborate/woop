export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

type LogLevel = keyof Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

function write(level: LogLevel, domain: string, message: string, context?: LogContext): void {
  if (level === 'debug' && !import.meta.env.DEV) return;

  const output = console[level];
  const label = `[${domain}] ${message}`;
  if (context && Object.keys(context).length > 0) {
    output.call(console, label, context);
    return;
  }
  output.call(console, label);
}

/**
 * Stable logging boundary for the web app. Callers provide a domain and
 * structured metadata; debug output is stripped from normal production use.
 * Document content and filesystem paths must not be included in metadata.
 */
export function createLogger(domain: string): Logger {
  return {
    debug: (message, context) => write('debug', domain, message, context),
    info: (message, context) => write('info', domain, message, context),
    warn: (message, context) => write('warn', domain, message, context),
    error: (message, context) => write('error', domain, message, context),
  };
}
