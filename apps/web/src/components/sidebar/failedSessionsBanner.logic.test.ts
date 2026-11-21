import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { FAILED_SESSIONS_WINDOW_MS, failedSessionsGroups } from "./failedSessionsBanner.logic";

const nowMs = Date.parse("2026-11-21T12:00:00.000Z");
const local = EnvironmentId.make("environment-local");
const remote = EnvironmentId.make("environment-remote");

const failedShell = (
  id: string,
  failedAgoMs: number,
  overrides: Partial<ReturnType<typeof makeThreadFixture>["source"]> = {},
  environmentId = local,
) =>
  presentThreadShell(environmentId, {
    ...makeThreadFixture().source,
    id: ThreadId.make(id),
    latestRunId: RunId.make(`run-${id}`),
    status: "failed",
    latestRunCompletedAt: DateTime.makeUnsafe(nowMs - failedAgoMs),
    lastErrorClass: "provider_error",
    lastErrorRetryable: true,
    ...overrides,
  });

describe("failedSessionsGroups", () => {
  it("counts recent transient failures per environment and skips the rest", () => {
    const { groups, expiresAtMs } = failedSessionsGroups(
      [
        failedShell("gateway", 10 * 60_000),
        failedShell("stream", 50 * 60_000, { lastErrorClass: "transport_error" }),
        failedShell("remote", 5 * 60_000, {}, remote),
        failedShell("old", FAILED_SESSIONS_WINDOW_MS + 1),
        failedShell("cyber", 60_000, { lastErrorRetryable: false }),
        failedShell("unclassified", 60_000, { lastErrorRetryable: null }),
        failedShell("limited", 60_000, { lastErrorClass: "usage_limit" }),
        failedShell("archived", 60_000, { archivedAt: DateTime.makeUnsafe(nowMs) }),
        failedShell("settled", 60_000, { settledOverride: "settled" }),
        failedShell("snoozed", 60_000, { snoozedUntil: DateTime.makeUnsafe(nowMs + 60_000) }),
        failedShell("completed", 60_000, { status: "completed" }),
      ],
      nowMs,
      new Map(),
    );

    const since = new Date(nowMs - FAILED_SESSIONS_WINDOW_MS).toISOString();
    expect(groups).toEqual([
      { environmentId: local, count: 2, since },
      { environmentId: remote, count: 1, since },
    ]);
    expect(expiresAtMs).toBe(nowMs - 50 * 60_000 + FAILED_SESSIONS_WINDOW_MS);
  });

  it("hides failures older than the last Resume all on that environment", () => {
    const shells = [failedShell("before", 20 * 60_000), failedShell("after", 5 * 60_000)];
    const { groups } = failedSessionsGroups(shells, nowMs, new Map([[local, nowMs - 10 * 60_000]]));
    expect(groups.map((group) => group.count)).toEqual([1]);
    expect(failedSessionsGroups([], nowMs, new Map())).toEqual({ groups: [], expiresAtMs: null });
  });
});
