import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { isTransientProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";

export const FAILED_SESSIONS_WINDOW_MS = 60 * 60 * 1_000;

export interface FailedSessionsGroup {
  readonly environmentId: EnvironmentId;
  readonly count: number;
  /** Start of the window, sent as Resume all's `since`. */
  readonly since: string;
}

/**
 * Threads per environment whose latest run failed on a transient provider error in the last
 * hour, the ones Resume all can resume. `resumedAt` hides failures older than the last Resume
 * all, so a thread the server declined does not keep the banner up.
 */
export function failedSessionsGroups(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  nowMs: number,
  resumedAt: ReadonlyMap<EnvironmentId, number>,
): {
  readonly groups: ReadonlyArray<FailedSessionsGroup>;
  /** When the oldest counted failure leaves the window. */
  readonly expiresAtMs: number | null;
} {
  const windowStartMs = nowMs - FAILED_SESSIONS_WINDOW_MS;
  const counts = new Map<EnvironmentId, number>();
  let oldestMs: number | null = null;
  for (const shell of shells) {
    const completedAt = shell.latestRun?.completedAt;
    if (
      shell.latestRun?.status !== "failed" ||
      completedAt == null ||
      shell.archivedAt !== null ||
      shell.settledOverride === "settled" ||
      (shell.snoozedUntil !== null && Date.parse(shell.snoozedUntil) > nowMs) ||
      !isTransientProviderFailure({
        class: shell.runtime?.lastErrorClass,
        retryable: shell.runtime?.lastErrorRetryable,
      })
    )
      continue;
    const failedMs = Date.parse(completedAt);
    if (
      !(failedMs >= windowStartMs) ||
      failedMs < (resumedAt.get(shell.environmentId) ?? -Infinity)
    )
      continue;
    counts.set(shell.environmentId, (counts.get(shell.environmentId) ?? 0) + 1);
    oldestMs = oldestMs === null ? failedMs : Math.min(oldestMs, failedMs);
  }
  const since = new Date(windowStartMs).toISOString();
  return {
    groups: [...counts].map(([environmentId, count]) => ({ environmentId, count, since })),
    expiresAtMs: oldestMs === null ? null : oldestMs + FAILED_SESSIONS_WINDOW_MS,
  };
}
