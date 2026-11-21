import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface ProgressReporter {
  /** False when the client supplied no progress token. */
  readonly enabled: boolean;
  /** Reports a strictly increasing value; regressions are dropped. Never throws. */
  report(progress: number, total?: number, message?: string): void;
}

const NOOP: ProgressReporter = {
  enabled: false,
  report() {
    // No token: the client did not ask for progress.
  },
};

/**
 * Binds one reporter to one tool call. MCP requires the same token for every
 * notification in a call, and progress values must only increase.
 */
export function createProgressReporter(
  extra?: Pick<ToolExtra, "sendNotification" | "_meta">
): ProgressReporter {
  const token = extra?._meta?.progressToken;
  if (!extra || token === undefined || token === null) return NOOP;

  let last = Number.NEGATIVE_INFINITY;
  return {
    enabled: true,
    report(progress, total, message) {
      if (!Number.isFinite(progress) || progress <= last) return;
      last = progress;
      const params: {
        progressToken: string | number;
        progress: number;
        total?: number;
        message?: string;
      } = { progressToken: token, progress };
      if (typeof total === "number" && Number.isFinite(total)) params.total = total;
      if (message) params.message = message;
      try {
        void Promise.resolve(
          extra.sendNotification({ method: "notifications/progress", params })
        ).catch(() => undefined);
      } catch {
        // Progress is advisory; it must never fail a tool call.
      }
    },
  };
}
