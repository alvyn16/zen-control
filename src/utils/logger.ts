export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(scope: string, explicit?: LogLevel): Logger {
  const configured =
    explicit ??
    (process.env.ZEN_CONTROL_LOG || "info").toLowerCase();
  const threshold = LEVELS[configured as LogLevel] ?? LEVELS.info;
  const emit = (level: LogLevel, message: string) => {
    if (LEVELS[level] < threshold) return;
    // stdout belongs to the MCP transport; all diagnostics go to stderr.
    process.stderr.write(`${new Date().toISOString()} [${scope}] ${level}: ${message}\n`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}
