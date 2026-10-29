type Level = 'debug' | 'info' | 'warn' | 'error';

const levels: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = (process.env.LOG_LEVEL as Level) || 'info';
const threshold = levels[configuredLevel] ?? levels.info;

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  if (levels[level] < threshold) return;
  const record: Record<string, unknown> = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta ?? {}),
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};

/** Remove credentials and connection strings from errors before logging or exposing them. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/(amqps?|rediss?):\/\/[^\s]+/gi, '[connection-redacted]')
      .replace(/postgres(ql)?:\/\/[^\s]+/gi, '[connection-redacted]')
      .slice(0, 500);
  }
  return String(error).slice(0, 500);
}
