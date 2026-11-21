import { assert, it } from "@effect/vitest";
import {
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
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
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
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
  status: "running" | "failed";
  completedAt: DateTime.Utc | null;
  failure: OrchestrationV2ProviderFailure | null;
  stopRequested: boolean;
}

/** One thread whose runs the test fails by hand; dispatched retries start a run unless told not to. */
const makeWorld = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const runs: Array<FakeRun> = [];
  const messages = new Set<MessageId>();
  let startRuns = true;
  const changed = Queue.offer(events, { type: "run.updated" } as never);

  const addRun = (userMessageId: MessageId) => {
    runs.push({
      id: RunId.make(`run:${runs.length + 1}`),
      ordinal: runs.length + 1,
      userMessageId,
      status: "running",
      completedAt: null,
      failure: null,
      stopRequested: false,
    });
  };
  addRun(MessageId.make("message:user"));

  const asRun = (run: FakeRun) => ({
    ...run,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "claude-haiku-5-5" },
    activeAttemptId: null,
    startedAt: DateTime.makeUnsafe(0),
    requestedAt: DateTime.makeUnsafe(0),
  });
  const thread = {
    id: threadId,
    providerInstanceId,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
  };

  const layer = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getTransientFailureCandidates: (since) =>
        Effect.sync(() => {
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
                },
              ]
            : [];
        }),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: ((_threadId: ThreadId, _fields: unknown, filter: any) =>
        Effect.sync(() => ({
          thread,
          messages: [...messages]
            .filter((id) => filter.messageIds?.includes(id))
            .map((id) => ({ id })),
          runs: runs.map(asRun),
          providerTurns: [],
          runtimeRequests: [],
          turnItems: filter.turnItemTypes?.includes("run_interrupt_request")
            ? runs
                .filter((run) => run.stopRequested)
                .map((run) => ({ type: "run_interrupt_request", runId: run.id }))
            : [],
        }))) as never,
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type === "message.dispatch") {
            messages.add(command.messageId);
            if (startRuns) addRun(command.messageId);
          }
          yield* Queue.offer(commands, command);
          yield* changed;
          return {} as never;
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

  const failLatest = (failure: OrchestrationV2ProviderFailure, stopRequested = false) =>
    Effect.gen(function* () {
      const run = runs.at(-1)!;
      run.status = "failed";
      run.completedAt = yield* DateTime.now;
      run.failure = failure;
      run.stopRequested = stopRequested;
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
    holdRuns: () => {
      startRuns = false;
    },
    startHeldRun: (messageId: MessageId) => {
      startRuns = true;
      addRun(messageId);
    },
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
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:2");

      yield* TestClock.adjust("5 seconds");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("175 seconds");
      assert.equal(yield* Queue.size(world.commands), 0);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:3");

      yield* TestClock.adjust("5 seconds");
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Queue.size(world.commands), 0);
    }).pipe(Effect.provide(world.worker));
  }),
);

it.effect("never resumes a cyber-filter refusal or a run the user stopped", () =>
  Effect.gen(function* () {
    for (const [failure, stopped] of [
      [
        {
          class: "provider_error",
          message: "This content was flagged for possible cybersecurity risk.",
          code: "cyberPolicy",
          retryable: false,
        },
        false,
      ],
      [gateway502, true],
    ] as const) {
      const world = yield* makeWorld;
      yield* Effect.gen(function* () {
        yield* world.failLatest(failure, stopped);
        yield* TestClock.adjust("1 hour");
        assert.equal(yield* Queue.size(world.commands), 0);
      }).pipe(Effect.provide(world.worker));
    }
  }),
);

it.effect("a restart between tries does not resume the same try twice", () =>
  Effect.gen(function* () {
    const world = yield* makeWorld;
    world.holdRuns();
    yield* world.failLatest(gateway502);
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("15 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:1");
    }).pipe(Effect.provide(world.worker));

    // The server restarts with the first try sent but its run not yet started.
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("1 minute");
      assert.equal(yield* Queue.size(world.commands), 0);
      world.startHeldRun(MessageId.make("message:transient-retry:run:1:1"));
      yield* world.failLatest(gateway502);
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* world.nextCommandId, "command:transient-retry:run:1:2");
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
