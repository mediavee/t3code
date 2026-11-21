import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ResumeFailedThreadsInput,
  OrchestrationV2ResumeFailedThreadsError,
  type OrchestrationV2ResumeFailedThreadsResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import {
  CONTINUE_PROMPT,
  restartContinuationBlocked,
  restartStopRequested,
} from "./RestartContinuation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Wait before each automatic try; its length is the number of tries per original run. */
const TRANSIENT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000] as const;
// Covers every backoff, with room for a server that was down when a try fell due.
const AUTO_RETRY_LOOKBACK_MS = 60 * 60 * 1_000;

// Retries carry their origin and try number in their ids, so a restart re-derives the same
// next try instead of keeping a counter, and a replayed dispatch collides with the first.
const RETRY_MESSAGE_PREFIX = "message:transient-retry:";
const RETRY_MESSAGE_ID = /^message:transient-retry:(.+):([1-9]\d*)$/u;

function transientRetryTry(failedRun: {
  readonly runId: RunId;
  readonly userMessageId: MessageId;
}) {
  const match = RETRY_MESSAGE_ID.exec(failedRun.userMessageId);
  const originRunId = match === null ? failedRun.runId : match[1]!;
  const attempt = match === null ? 1 : Number(match[2]) + 1;
  return {
    attempt,
    messageId: MessageId.make(`${RETRY_MESSAGE_PREFIX}${originRunId}:${attempt}`),
    commandId: CommandId.make(`command:transient-retry:${originRunId}:${attempt}`),
  };
}

/** When the next automatic try for this failed run falls due; null once the tries are spent. */
function transientRetryDueAtMs(
  candidate: ProjectionStore.ProjectionTransientFailureCandidate,
): number | null {
  const delay = TRANSIENT_RETRY_DELAYS_MS[transientRetryTry(candidate).attempt - 1];
  return delay === undefined ? null : DateTime.toEpochMillis(candidate.completedAt) + delay;
}

const affectsTransientRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type.startsWith("thread.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

export class TransientFailureRecovery extends Context.Service<
  TransientFailureRecovery,
  {
    readonly resumeFailedThreads: (
      input: OrchestrationV2ResumeFailedThreadsInput,
    ) => Effect.Effect<
      OrchestrationV2ResumeFailedThreadsResult,
      OrchestrationV2ResumeFailedThreadsError
    >;
  }
>()("t3/orchestration-v2/TransientFailureRecoveryWorker/TransientFailureRecovery") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  /** Re-reads the thread so a stale candidate cannot resume work that moved on. */
  const resumeRun = Effect.fn("TransientFailureRecovery.resumeRun")(function* (
    candidate: ProjectionStore.ProjectionTransientFailureCandidate,
  ) {
    const next = transientRetryTry(candidate);
    const projection = yield* threads.getThreadRecords(
      candidate.threadId,
      ["messages", "runs", "providerTurns", "runtimeRequests", "turnItems"],
      { messageIds: [next.messageId], turnItemTypes: ["secret_request"] },
    );
    if (projection.messages.some((message) => message.id === next.messageId)) return false;
    const source = projection.runs.find((run) => run.id === candidate.runId);
    if (
      source?.status !== "failed" ||
      projection.thread.providerInstanceId !== source.providerInstanceId ||
      restartContinuationBlocked(projection, source, yield* DateTime.now, true) ||
      projection.runs.some(
        (run) =>
          run.id !== source.id &&
          run.status !== "queued" &&
          !cancelledBeforeStart(run) &&
          runRanAfter(run, source),
      ) ||
      (yield* restartStopRequested(threads.getThreadRecords, projection.thread, source))
    )
      return false;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: next.commandId,
      threadId: candidate.threadId,
      messageId: next.messageId,
      text: CONTINUE_PROMPT,
      notification: {
        source: { kind: "system" },
        outcome: "updated",
        summary: "T3 Code resumed this turn after a provider error",
        detail: CONTINUE_PROMPT,
      },
      attachments: [],
      modelSelection: source.modelSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    return true;
  });

  const tryResume = (candidate: ProjectionStore.ProjectionTransientFailureCandidate) =>
    resumeRun(candidate).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.transient-recovery.dispatch-failed", {
          threadId: candidate.threadId,
          runId: candidate.runId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsTransientRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  const sweep = Effect.fn("TransientFailureRecovery.sweep")(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    if (!(yield* settings.getSettings).autoRetryTransientFailures) {
      yield* due.record(readVersion, Infinity, nowMs);
      return;
    }
    const candidates = yield* projections.getTransientFailureCandidates(
      DateTime.makeUnsafe(nowMs - AUTO_RETRY_LOOKBACK_MS),
    );
    let wakeAt = Infinity;
    let acted = false;
    for (const candidate of candidates) {
      const dueAt = transientRetryDueAtMs(candidate);
      if (dueAt === null) continue;
      if (dueAt > nowMs) {
        wakeAt = Math.min(wakeAt, dueAt);
        continue;
      }
      acted = true;
      yield* tryResume(candidate);
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (!acted) yield* due.record(readVersion, wakeAt, nowMs);
  });

  const scheduler = yield* Scheduler.Scheduler;
  yield* scheduler.register("transient-failure-recovery", sweep());

  return TransientFailureRecovery.of({
    resumeFailedThreads: Effect.fn("TransientFailureRecovery.resumeFailedThreads")(
      function* (input) {
        const since = DateTime.make(input.since);
        if (Option.isNone(since)) return yield* new OrchestrationV2ResumeFailedThreadsError({});
        const candidates = yield* projections
          .getTransientFailureCandidates(DateTime.toUtc(since.value))
          .pipe(Effect.mapError((cause) => new OrchestrationV2ResumeFailedThreadsError({ cause })));
        const resumedThreadIds: Array<ThreadId> = [];
        for (const candidate of candidates) {
          if (yield* tryResume(candidate)) resumedThreadIds.push(candidate.threadId);
        }
        return { resumedThreadIds };
      },
    ),
  });
});

export const layer = Layer.effect(TransientFailureRecovery, make);
