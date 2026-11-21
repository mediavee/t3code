import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
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
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import { CONTINUE_PROMPT } from "./RestartContinuation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** Wait before each automatic try; its length is the number of tries per original run. */
const TRANSIENT_RETRY_DELAYS_MS = [15_000, 60_000, 180_000] as const;
// Covers every backoff, with room for a server that was down when a try fell due.
const AUTO_RETRY_LOOKBACK_MS = 60 * 60 * 1_000;

// Retries carry their chain's original run and try number in their ids, so a restart
// re-derives the same next try instead of keeping a counter, and a replayed dispatch collides
// with the first.
const RETRY_MESSAGE_PREFIX = "message:transient-retry:";
const RETRY_MESSAGE_ID = /^message:transient-retry:(.+):([1-9]\d*)$/u;
// Bounds the walk over restart and limit-resume runs back to the last try or original run.
const MAX_CHAIN_HOPS = 64;

const transientRetryTry = (originRunId: string, attempt: number) => ({
  attempt,
  messageId: MessageId.make(`${RETRY_MESSAGE_PREFIX}${originRunId}:${attempt}`),
  commandId: CommandId.make(`command:transient-retry:${originRunId}:${attempt}`),
});

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

  const readRun = (threadId: ThreadId, runId: RunId) =>
    threads
      .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
      .pipe(Effect.map(({ runs }) => runs[0]));

  /**
   * The next try of the chain this failed run ends. Restart and limit-resume runs continue the
   * same chain, so tries count from its original run. A run that spent the provider's own
   * retry budget gets only the chain's last try.
   */
  const nextTry = Effect.fn("TransientFailureRecovery.nextTry")(function* (
    candidate: ProjectionStore.ProjectionTransientFailureCandidate,
  ) {
    const after = (originRunId: string, tries: number) => {
      const attempt = candidate.spentRetryBudget
        ? Math.max(tries + 1, TRANSIENT_RETRY_DELAYS_MS.length)
        : tries + 1;
      const delay = TRANSIENT_RETRY_DELAYS_MS[attempt - 1];
      return {
        ...transientRetryTry(originRunId, attempt),
        dueAtMs: delay === undefined ? null : DateTime.toEpochMillis(candidate.completedAt) + delay,
      };
    };
    let runId = candidate.runId;
    let messageId = candidate.userMessageId;
    let run: OrchestrationV2Run | undefined;
    for (let hop = 0; hop < MAX_CHAIN_HOPS; hop += 1) {
      const match = RETRY_MESSAGE_ID.exec(messageId);
      if (match !== null) return after(match[1]!, Number(match[2]));
      run ??= yield* readRun(candidate.threadId, runId);
      const previousRunId = run?.restartContinuationOfRunId ?? run?.usageLimitContinuationOfRunId;
      const previous =
        previousRunId === undefined ? undefined : yield* readRun(candidate.threadId, previousRunId);
      if (previous === undefined) return after(runId, 0);
      run = previous;
      runId = previous.id;
      messageId = previous.userMessageId;
    }
    return null;
  });

  const nextTryOrNull = (candidate: ProjectionStore.ProjectionTransientFailureCandidate) =>
    nextTry(candidate).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.transient-recovery.chain-read-failed", {
          threadId: candidate.threadId,
          runId: candidate.runId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  /** The orchestrator re-checks the run is still due under the thread lock; a stale try is a no-op. */
  const resumeRun = Effect.fn("TransientFailureRecovery.resumeRun")(function* (
    candidate: ProjectionStore.ProjectionTransientFailureCandidate,
    next: ReturnType<typeof transientRetryTry>,
  ) {
    const { messages } = yield* threads.getThreadRecords(candidate.threadId, ["messages"], {
      messageIds: [next.messageId, candidate.userMessageId],
    });
    if (messages.some((message) => message.id === next.messageId)) return false;
    const sourceMessage = messages.find((message) => message.id === candidate.userMessageId);
    if (sourceMessage !== undefined && isNativeMaintenanceCommand(sourceMessage)) return false;
    const dispatched = yield* threads.dispatch({
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
      transientFailureContinuationOfRunId: candidate.runId,
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    return dispatched.storedEvents.some((stored) => stored.event.type === "run.created");
  });

  const tryResume = (
    candidate: ProjectionStore.ProjectionTransientFailureCandidate,
    next: ReturnType<typeof transientRetryTry>,
  ) =>
    resumeRun(candidate, next).pipe(
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
      DateTime.makeUnsafe(nowMs),
    );
    let wakeAt = Infinity;
    let acted = false;
    for (const candidate of candidates) {
      const next = yield* nextTryOrNull(candidate);
      if (next?.dueAtMs == null) continue;
      if (next.dueAtMs > nowMs) {
        wakeAt = Math.min(wakeAt, next.dueAtMs);
        continue;
      }
      if (yield* tryResume(candidate, next)) acted = true;
    }
    // A sweep that resumed a run re-checks on the next tick; a declined one waits for a change.
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
          .getTransientFailureCandidates(DateTime.toUtc(since.value), yield* DateTime.now)
          .pipe(Effect.mapError((cause) => new OrchestrationV2ResumeFailedThreadsError({ cause })));
        const resumedThreadIds: Array<ThreadId> = [];
        for (const candidate of candidates) {
          const next = yield* nextTryOrNull(candidate);
          if (next !== null && (yield* tryResume(candidate, next)))
            resumedThreadIds.push(candidate.threadId);
        }
        return { resumedThreadIds };
      },
    ),
  });
});

export const layer = Layer.effect(TransientFailureRecovery, make);
