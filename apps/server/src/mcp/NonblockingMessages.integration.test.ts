import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-test" };
const projectId = ProjectId.make("project:nonblocking-messages");

const harness = Effect.fn("nonblockingMessagesHarness")(function* (name: string) {
  const cwd = yield* checkpointWorkspace(name);
  const turns: Array<{
    readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput;
    readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
  }> = [];
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: ClaudeProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              turns.push({ turn, events });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              });
            }),
          // The provider holds a steer until the agent reads it, which these tests never do.
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layerAdapters = ProviderAdapterRegistry.layerSingle(adapter);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry({ name }, layerAdapters, {
    runEffectWorker: false,
  });
  // The real orchestrator; only signals when a wait starts listening for the caller's messages.
  const listening = yield* Deferred.make<void>();
  const layerObservedOrchestrator = Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return {
        ...orchestrator,
        streamStoredEventsFrom: (
          input: Parameters<typeof orchestrator.streamStoredEventsFrom>[0],
        ) =>
          input?.eventType === "message.updated"
            ? Stream.fromEffect(Deferred.succeed(listening, undefined)).pipe(
                Stream.drain,
                Stream.concat(orchestrator.streamStoredEventsFrom(input)),
              )
            : orchestrator.streamStoredEventsFrom(input),
      };
    }),
  ).pipe(Layer.provide(layerOrchestrator));
  const layerOrchestration = Layer.merge(
    layerOrchestrator,
    ThreadManagementService.layer.pipe(
      Layer.provide(layerObservedOrchestrator),
      Layer.provide(layerOrchestrator),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
    ),
  );
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(layerOrchestration),
    Layer.provide(
      Layer.mergeAll(
        layerAdapters,
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        ServerSettings.layerTest(),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );

  const scopeOf = (threadId: ThreadId): McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment:nonblocking-messages"),
    requestNamespace: `provider-session:${threadId}`,
    thread: {
      threadId,
      providerSessionId: `provider-session:${threadId}`,
      providerInstanceId: instanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });

  const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return yield* orchestrator.streamDomainEvents.pipe(
        Stream.filter(predicate),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );
    });
  const turnRunning = (threadId: ThreadId) =>
    watch(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.threadId === threadId &&
        event.payload.status === "running",
    );

  /** A top-level thread whose first turn is running. */
  const startThread = Effect.fn("startThread")(function* (id: string) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:nonblocking-${id}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId,
      projectId,
      title: id,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* turnRunning(threadId);
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`start-${id}`),
      threadId,
      messageId: MessageId.make(`message:start-${id}`),
      text: `Work on ${id}`,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });

  /** Ends the thread's running turn as completed. */
  const completeTurn = Effect.fn("completeTurn")(function* (threadId: ThreadId) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const entry = turns.findLast((candidate) => candidate.turn.threadId === threadId)!;
    const turn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns.findLast(
      (candidate) => candidate.runAttemptId === entry.turn.attemptId,
    )!;
    const ended = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === entry.turn.runId &&
        (event.payload.status === "waiting" || event.payload.status === "completed"),
    );
    const now = yield* DateTime.now;
    yield* Queue.offer(entry.events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn, status: "completed", completedAt: now },
    });
    yield* Queue.offer(entry.events, {
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: entry.turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Fiber.join(ended);
    yield* worker.drain();
  });

  return { layer, listening, scopeOf, startThread, completeTurn, turns, watch };
});

it.effect("a wait on a slow thread returns once another thread messages the caller", () =>
  Effect.gen(function* () {
    const { layer, listening, scopeOf, startThread } = yield* harness("nonblocking-wait");
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const lead = yield* startThread("lead");
      const slow = yield* startThread("slow");
      const worker = yield* startThread("worker");
      const waiting = yield* service
        .waitForThread(scopeOf(lead), { threadId: slow, timeoutMs: 10 * 60 * 1_000 })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(listening);
      const sent = yield* service.sendToThread(scopeOf(worker), {
        threadId: lead,
        message: "REPORT done",
        clientRequestId: "worker-report",
      });
      assert.equal(sent.delivery, "steered");
      // Past the wait's timeout: a wait that missed the message would now report it.
      yield* TestClock.adjust("10 minutes");
      const result = yield* Fiber.join(waiting);
      assert.deepInclude(result, {
        threadId: slow,
        status: "running",
        timedOut: false,
        interruptedByIncomingMessage: true,
        waitingMessages: 1,
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("an expiring send to a thread whose turn ended is dropped, not started", () =>
  Effect.gen(function* () {
    const { layer, scopeOf, startThread, completeTurn, turns } =
      yield* harness("nonblocking-expire");
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const lead = yield* startThread("expire-lead");
      const target = yield* startThread("expire-target");
      yield* completeTurn(target);
      const before = yield* orchestrator.getThreadProjection(target);
      const sent = yield* service.sendToThread(scopeOf(lead), {
        threadId: target,
        message: "Use the other flag",
        expireOnTurnEnd: true,
        clientRequestId: "late-correction",
      });
      assert.deepInclude(sent, {
        delivery: "dropped",
        runId: before.runs[0]!.id,
        status: "completed",
      });
      const after = yield* orchestrator.getThreadProjection(target);
      assert.deepEqual(
        after.runs.map((run) => run.id),
        before.runs.map((run) => run.id),
      );
      assert.isUndefined(after.messages.find((message) => message.id === sent.messageId));
      assert.equal(turns.filter((entry) => entry.turn.threadId === target).length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("task_cancel drops the messages agents queued on the task's thread", () =>
  Effect.gen(function* () {
    const { layer, scopeOf, startThread, watch } = yield* harness("nonblocking-cancel");
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const lead = yield* startThread("cancel-lead");
      const other = yield* startThread("cancel-other");
      const leadRun = (yield* orchestrator.getThreadProjection(lead)).runs[0]!;
      const childRunning = yield* watch(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.threadId !== lead &&
          event.threadId !== other &&
          event.payload.status === "running",
      );
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: lead,
        parentRunId: leadRun.id,
        parentNodeId: leadRun.rootNodeId!,
        task: "Review the change",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* worker.drain();
      yield* Fiber.join(childRunning);
      const task = (yield* orchestrator.getThreadProjection(lead)).subagents[0]!;
      const child = task.childThreadId!;
      const queue = (id: string, createdBy: "agent" | "user") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`queue-${id}`),
          threadId: child,
          messageId: MessageId.make(`message:queue-${id}`),
          text: id,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          ...(createdBy === "agent" ? { senderThreadId: other } : {}),
          createdBy,
          creationSource: createdBy === "agent" ? "mcp" : "web",
        });
      yield* queue("agent", "agent");
      yield* queue("owner", "user");

      yield* service.cancelTask(scopeOf(lead), { taskId: task.id, clientRequestId: "cancel" });

      const runs = (yield* orchestrator.getThreadProjection(child)).runs;
      const statusOf = (id: string) =>
        runs.find((run) => run.userMessageId === MessageId.make(`message:queue-${id}`))?.status;
      assert.equal(statusOf("agent"), "cancelled");
      assert.equal(statusOf("owner"), "queued");
    }).pipe(Effect.provide(layer));
  }),
);
