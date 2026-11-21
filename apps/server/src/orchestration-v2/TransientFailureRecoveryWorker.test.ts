import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { isTransientProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as TransientFailureRecoveryWorker from "./TransientFailureRecoveryWorker.ts";

const threadId = ThreadId.make("thread:transient");
const gateway502: OrchestrationV2ProviderFailure = {
  class: "provider_error",
  message: "API Error: 502 Bad Gateway",
  code: "api_error_502",
  retryable: true,
};

interface FakeRun {
  readonly id: RunId;
  readonly ordinal: number;
  readonly userMessageId: MessageId;
  readonly restartContinuationOfRunId?: RunId;
  readonly usageLimitContinuationOfRunId?: RunId;
  status: "running" | "failed";
  completedAt: DateTime.Utc | null;
  failure: OrchestrationV2ProviderFailure | null;
  spentRetryBudget: boolean;
}

/**
 * One thread whose runs the test fails by hand. A dispatched retry starts a run, or is held
 * (recorded, run not started yet) or declined (the orchestrator's accepted no-op).
 */
const makeWorld = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const runs: Array<FakeRun> = [];
  const messages = new Map<MessageId, { readonly id: MessageId; readonly text: string }>();
  let mode: "start" | "hold" | "decline" = "start";
  let candidateQueries = 0;
  const accepted = new Set<string>();
  const changed = Queue.offer(events, { type: "run.updated" } as never);

  const addRun = (
    userMessageId: MessageId,
    text = "Build it",
    continuationOf: Pick<
      FakeRun,
      "restartContinuationOfRunId" | "usageLimitContinuationOfRunId"
    > = {},
  ) => {
    messages.set(userMessageId, { id: userMessageId, text });
    runs.push({
      id: RunId.make(`run:${runs.length + 1}`),
      ordinal: runs.length + 1,
      userMessageId,
      ...continuationOf,
      status: "running",
      completedAt: null,
      failure: null,
      spentRetryBudget: false,
    });
  };
  addRun(MessageId.make("message:user"));

  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getTransientFailureCandidates: (since) =>
        Effect.sync(() => {
          candidateQueries += 1;
          const latest = runs.at(-1)!;
          return latest.status === "failed" &&
            latest.failure !== null &&
            isTransientProviderFailure(latest.failure) &&
            latest.completedAt !== null &&
            DateTime.toEpochMillis(latest.completedAt) >= DateTime.toEpochMillis(since)
            ? [
                {
                  threadId,
                  runId: latest.id,
                  userMessageId: latest.userMessageId,
                  completedAt: latest.completedAt,
                  spentRetryBudget: latest.spentRetryBudget,
                },
              ]
            : [];
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: ((
        _threadId: ThreadId,
        _fields: unknown,
        filter: {
          readonly messageIds?: ReadonlyArray<MessageId>;
          readonly runIds?: ReadonlyArray<RunId>;
        },
      ) =>
        Effect.sync(() => ({
          messages: (filter.messageIds ?? []).flatMap((id) => {
            const message = messages.get(id);
            return message === undefined ? [] : [{ ...message, attachments: [] }];
          }),
          runs: runs.filter((run) => filter.runIds?.includes(run.id)),
        }))) as never,
      dispatch: (command) =>
        Effect.gen(function* () {
          yield* Queue.offer(commands, command);
          // A replayed command id returns its first receipt and records nothing new.
          if (accepted.has(command.commandId)) return { storedEvents: [] } as never;
          accepted.add(command.commandId);
          let started = false;
          if (command.type === "message.dispatch" && mode !== "decline") {
            messages.set(command.messageId, { id: command.messageId, text: command.text });
            if (mode === "start") {
              addRun(command.messageId, command.text);
              started = true;
            }
          }
          yield* changed;
          return {
            storedEvents: started ? [{ event: { type: "run.created" } }] : [],
          } as never;
        }),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({ autoRetryTransientFailures: true } as never),
      streamChanges: Stream.never,
    }),
  );
  const worker = TransientFailureRecoveryWorker.layer.pipe(
    Layer.provide(Layer.merge(layer, Scheduler.layer)),
  );

  const failLatest = (failure: OrchestrationV2ProviderFailure, spentRetryBudget = false) =>
    Effect.gen(function* () {
      const run = runs.at(-1)!;
      run.status = "failed";
      run.completedAt = yield* DateTime.now;
      run.failure = failure;
      run.spentRetryBudget = spentRetryBudget;
      yield* changed;
    });
  const nextCommandId = Queue.take(commands).pipe(
    Effect.map((command) => (command.type === "message.dispatch" ? command.commandId : null)),
  );
  return {
    worker,
    commands,
    failLatest,
    nextCommandId,
    setMode: (next: typeof mode) => {
      mode = next;
    },
    startRun: addRun,
    runCount: () => runs.length,
    latestMessageId: () => runs.at(-1)!.userMessageId,
    candidateQueries: () => candidateQueries,
  };
});

it.effect("resumes a 502 failure after 15 s, 60 s and 3 min, then leaves it failed", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* Effect.gen(function* () {
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("10 seconds");
      assert.equal(yield* Queue.size(world.commands), 0);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");

      yield* TestClock.adjust("5 seconds");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("55 seconds");
      assert.equal(yield* Queue.size(world.commands), 0);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:2:2");

      yield* TestClock.adjust("5 seconds");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("175 seconds");
      assert.equal(yield* Queue.size(world.commands), 0);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:3:3");

      yield* TestClock.adjust("5 seconds");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(world.commands), 0);
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("never resumes a cyber-filter refusal or a native maintenance command", () =>
  Effect.gen(function* () {
    const cyber = yield* makeWorld;
    yield* Effect.gen(function* () {
      yield* cyber.failLatest({
        class: "provider_error",
        message: "This content was flagged for possible cybersecurity risk.",
        code: "cyberPolicy",
        retryable: false,
      });
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(cyber.commands), 0);
    }).pipe(Effect.provide(cyber.worker));

    const compact = yield* makeWorld;
    compact.startRun(MessageId.make("message:compact"), "/compact");
    yield* Effect.gen(function* () {
      yield* compact.failLatest(gateway502);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(compact.commands), 0);
    }).pipe(Effect.provide(compact.worker));
  }),
);

it.effect("a try the orchestrator declines waits for a change instead of polling", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    world.setMode("decline");
    yield* Effect.gen(function* () {
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");
      yield* TestClock.adjust("1 minute");
      const queries = world.candidateQueries();
      yield* TestClock.adjust("5 minutes");
      assert.equal(world.candidateQueries(), queries);
      // The no-op receipt's event brings one re-check, which replays the same command id.
      assert.isAtMost(yield* Queue.size(world.commands), 1);
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("a restart between tries does not resume the same try twice", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    world.setMode("hold");
    yield* world.failLatest(gateway502);
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");
    }).pipe(Effect.provide(world.worker));

    // The server restarts with the first try sent but its run not yet started.
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* Queue.size(world.commands), 0);
      world.setMode("start");
      world.startRun(MessageId.make("message:transient-retry:run:1:1"));
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:2:2");
      assert.equal(yield* Queue.size(world.commands), 0);
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("Resume all resumes a failed thread at once and the worker does not repeat it", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* Effect.gen(function* () {
      const recovery = yield* TransientFailureRecoveryWorker.TransientFailureRecovery;
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("1 second");
      const since = DateTime.formatIso(DateTime.makeUnsafe(0));
      assert.deepEqual(yield* recovery.resumeFailedThreads({ since }), {
        resumedThreadIds: [threadId],
      });
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(world.commands), 0);
      assert.deepEqual(yield* recovery.resumeFailedThreads({ since }), { resumedThreadIds: [] });
      const invalid = yield* recovery.resumeFailedThreads({ since: "yesterday" }).pipe(Effect.flip);
      assert.equal(invalid._tag, "OrchestrationV2ResumeFailedThreadsError");
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("a try declined for a run does not block the try for its failed continuation", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* Effect.gen(function* () {
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("15 seconds");
      assert.equal(world.runCount(), 2);

      // A restart cut the try short; its continuation failed and the next try lost a race.
      world.startRun(MessageId.make("message:restart-continuation:run:2"), "Continue", {
        restartContinuationOfRunId: RunId.make("run:2"),
      });
      world.setMode("decline");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("60 seconds");
      assert.isAbove(yield* Queue.size(world.commands), 1);
      assert.equal(world.runCount(), 3);

      // The winning continuation fails too; its own try must still start.
      world.setMode("start");
      world.startRun(MessageId.make("message:restart-continuation:run:3"), "Continue", {
        restartContinuationOfRunId: RunId.make("run:3"),
      });
      yield* Queue.clear(world.commands);
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("60 seconds");
      assert.equal(world.runCount(), 5);
      assert.equal(world.latestMessageId(), "message:transient-retry:run:1:2");
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("a spent provider budget is retried once per chain; plain errors keep their tries", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    yield* Effect.gen(function* () {
      // The provider gave up after its own 10 minutes: one try, after the longest wait.
      yield* world.failLatest(gateway502, true);
      yield* TestClock.adjust("175 seconds");
      assert.equal(yield* Queue.size(world.commands), 0);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");
      assert.equal(world.latestMessageId(), "message:transient-retry:run:1:1:budget");

      // A usage-limit resume continues the chain; a plain 502 there keeps the second try.
      world.startRun(MessageId.make("message:limit-resume:run:2"), "Continue", {
        usageLimitContinuationOfRunId: RunId.make("run:2"),
      });
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:3:2");
      assert.equal(world.latestMessageId(), "message:transient-retry:run:1:2:budget");

      // A second spent budget in the same chain is left failed.
      yield* world.failLatest(gateway502, true);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(world.commands), 0);
      assert.equal(world.runCount(), 4);
    }).pipe(Effect.provide(world.worker));
  }),
);
