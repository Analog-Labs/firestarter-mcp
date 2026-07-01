type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatLog(level: LogLevel, message: string, meta?: Record<string, any>): string {
  const entry: Record<string, any> = {
    time: new Date().toISOString(),
    level,
    msg: message,
  };
  if (meta) Object.assign(entry, meta);
  return JSON.stringify(entry);
}

export const logger = {
  debug(message: string, meta?: Record<string, any>) {
    if (shouldLog("debug")) process.stdout.write(formatLog("debug", message, meta) + "\n");
  },
  info(message: string, meta?: Record<string, any>) {
    if (shouldLog("info")) process.stdout.write(formatLog("info", message, meta) + "\n");
  },
  warn(message: string, meta?: Record<string, any>) {
    if (shouldLog("warn")) process.stderr.write(formatLog("warn", message, meta) + "\n");
  },
  error(message: string, meta?: Record<string, any>) {
    if (shouldLog("error")) process.stderr.write(formatLog("error", message, meta) + "\n");
  },
};
