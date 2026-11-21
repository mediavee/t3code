import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderApprovalFullAccessOverride,
  ProviderSessionId,
  type RuntimeMode,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as DelegatedTaskQuestionReactor from "../../../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EffectOutbox from "../../../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import { McpInvocationContext as InvocationContext } from "../../McpInvocationContext.ts";

// A delegated task's approvals reach the thread that delegated it, which answers them
// through its real T3 tool against this environment's real orchestrator.

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:child-approvals");
const environmentId = EnvironmentId.make("environment:child-approvals");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for these commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "child-approvals" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerOrchestration = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  ),
  DelegatedTaskQuestionReactor.layer,
).pipe(Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())));
const layerTools = McpHttpServer.layerThreadToolkit.pipe(
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(NodeCrypto.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "child-approvals", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "child-approvals", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `thread:${threadId}`,
  thread: { threadId, providerSessionId: `session:${threadId}`, providerInstanceId: instanceId },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const pendingRequest = (scope: McpInvocationContext.McpInvocationScope, args: object) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: "t3_pending_request", arguments: args })),
    Effect.provideService(InvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );
const failure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code: string; message: string })
    : undefined;
};

/** A thread with a running turn, as an agent calling its tools has. */
const runningThread = Effect.fn("test.runningThread")(function* (
  name: string,
  runtimeMode: RuntimeMode,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = `thread:${name}` as ThreadId;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${name}`),
    threadId,
    messageId: MessageId.make(`message:${name}`),
    text: "Delegate the cleanup",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

/** A task `parentThreadId` delegated, whose child waits on a live command approval. */
const childAskingApproval = Effect.fn("test.childAskingApproval")(function* (
  parentThreadId: ThreadId,
  runtimeMode: RuntimeMode,
  completionWake: "always" | "settled_only" = "always",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const parentRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make(`delegate:${parentThreadId}`),
    parentThreadId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: "Clean the build",
    completionWake,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const task = (yield* projections.getThreadRecords(parentThreadId, ["subagents"])).subagents[0]!;
  const childThreadId = task.childThreadId!;
  return { task, childThreadId, ask: yield* approvalAsker(childThreadId) };
});

/** A task `delegate_task` started in another project here, as the thread it runs as. */
const otherProjectTask = Effect.fn("test.otherProjectTask")(function* (
  name: string,
  completionWake: "always" | "settled_only",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const parentThreadId = yield* runningThread(`${name}-lead`, "full-access");
  const childThreadId = `thread:${name}-task` as ThreadId;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}-task`),
    threadId: childThreadId,
    projectId: ProjectId.make("project:other"),
    title: "Other project task",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    delegatedFrom: { environmentId, threadId: parentThreadId, title: `${name}-lead` },
    localDelegation: true,
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${name}-task`),
    threadId: childThreadId,
    messageId: MessageId.make(`message:${name}-task`),
    text: "Clean the build",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  const childRun = (yield* projections.getThreadRecords(childThreadId, ["runs"])).runs[0]!;
  const parentRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.remote.request",
    commandId: CommandId.make(`adopt:${name}-task`),
    parentThreadId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: "Clean the build",
    driver: adapter.driver,
    modelSelection,
    remoteChild: {
      environmentId,
      threadId: childThreadId,
      label: "this environment",
      runId: childRun.id,
    },
    completionWake,
  });
  return { parentThreadId, childThreadId };
});

/** Asks for command approvals on a thread's running turn, through a live provider session. */
const approvalAsker = Effect.fn("test.approvalAsker")(function* (childThreadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const childRun: OrchestrationV2Run = (yield* projections.getThreadRecords(childThreadId, [
    "runs",
  ])).runs[0]!;
  const now = yield* DateTime.now;
  const sessionId = ProviderSessionId.make(`session:${childThreadId}`);
  // A live approval comes from a turn that started, which records the modes it runs in.
  const child = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(childThreadId);
  const attempt = child.attempts.find((candidate) => candidate.id === childRun.activeAttemptId);
  if (attempt !== undefined)
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`event:started:${childThreadId}`),
          type: "run-attempt.updated",
          threadId: childThreadId,
          occurredAt: now,
          payload: {
            ...attempt,
            startedModes: {
              runtimeMode: child.thread.runtimeMode,
              interactionMode: child.thread.interactionMode,
            },
          },
        },
      ],
    });
  yield* projections.apply({
    id: EventId.make(`event:session:${childThreadId}`),
    type: "provider-session.attached",
    threadId: childThreadId,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  const ask = Effect.fn("test.ask")(function* (
    name: string,
    fullAccessOverride?: ProviderApprovalFullAccessOverride,
  ) {
    const requestId = RuntimeRequestId.make(`request:${childThreadId}:${name}`);
    const request = {
      id: EventId.make(`event:${requestId}`),
      type: "runtime-request.updated",
      threadId: childThreadId,
      runId: childRun.id,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: childRun.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({
      events: [
        request,
        {
          id: EventId.make(`event:item:${requestId}`),
          type: "turn-item.updated",
          threadId: childThreadId,
          runId: childRun.id,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${requestId}`),
            threadId: childThreadId,
            runId: childRun.id,
            nodeId: childRun.rootNodeId!,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "approval_request",
            requestId,
            requestKind: "command",
            prompt: `rm -rf build/${name}`,
            reason: "The build folder is stale.",
            ...(fullAccessOverride === undefined ? {} : { fullAccessOverride }),
          },
        },
      ],
    });
    return request;
  });
  return ask;
});

/** The parent's wake for a request; it queues behind the parent's running turn. */
const wakeFor = Effect.fn("test.wakeFor")(function* (
  parentThreadId: ThreadId,
  requestId: RuntimeRequestId,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const messageId = DelegatedTaskQuestionReactor.parentWakeMessageId(parentThreadId, requestId);
  const messages = yield* projections.getMessagesById(parentThreadId, [messageId]);
  const { runs } = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
  return {
    message: messages.get(messageId),
    run: runs.find((run) => run.userMessageId === messageId),
  };
});

it.layer(Layer.provideMerge(layerTools, layerOrchestration))(
  "a delegated task's approval",
  (it) => {
    it.effect("wakes its parent, which answers it within its own modes", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
        const parentThreadId = yield* runningThread("lead", "full-access");
        const { childThreadId, ask } = yield* childAskingApproval(parentThreadId, "full-access");

        // The parent wakes with what the child wants to run and why.
        const answeredHere = yield* ask("answered-here");
        yield* reactor.handle(answeredHere);
        const wake = yield* wakeFor(parentThreadId, answeredHere.payload.id);
        assert.include(
          wake.message?.text,
          "blocked on a command approval: rm -rf build/answered-here.",
        );
        assert.include(wake.message?.text, "Reason: The build folder is stale.");
        assert.include(wake.message?.text, `threadId ${childThreadId}`);
        assert.equal(
          wake.message?.notification?.summary,
          'Delegated task "Clean the build" needs approval',
        );
        assert.equal(wake.run?.status, "queued");

        const parent = threadScope(parentThreadId);
        const listed = yield* pendingRequest(parent, { action: "list", threadId: childThreadId });
        assert.deepEqual(listed.structuredContent, { requestIds: [answeredHere.payload.id] });
        const read = yield* pendingRequest(parent, {
          action: "read",
          threadId: childThreadId,
          requestId: answeredHere.payload.id,
        });
        assert.deepEqual(read.structuredContent, {
          requestId: answeredHere.payload.id,
          approval: {
            kind: "command",
            prompt: "rm -rf build/answered-here",
            reason: "The build folder is stale.",
            decisions: ["accept", "acceptForSession", "decline"],
          },
        });

        // The child itself cannot approve its own request, nor can a thread that did not delegate it.
        const own = yield* pendingRequest(threadScope(childThreadId), {
          action: "respond",
          requestId: answeredHere.payload.id,
          decision: "accept",
        });
        assert.equal(failure(own)?.code, "capability_denied");
        const stranger = yield* runningThread("stranger", "full-access");
        const notChild = yield* pendingRequest(threadScope(stranger), {
          action: "respond",
          threadId: childThreadId,
          requestId: answeredHere.payload.id,
          decision: "accept",
        });
        assert.equal(failure(notChild)?.code, "capability_denied");
        assert.deepEqual(
          (yield* pendingRequest(threadScope(stranger), {
            action: "list",
            threadId: childThreadId,
          })).structuredContent,
          { requestIds: [] },
        );

        const accepted = yield* pendingRequest(parent, {
          action: "respond",
          threadId: childThreadId,
          requestId: answeredHere.payload.id,
          decision: "accept",
        });
        assert.equal(accepted.isError, false, JSON.stringify(accepted.content));
        const request = yield* projections.getRuntimeRequest(
          childThreadId,
          answeredHere.payload.id,
        );
        assert.equal(request?.status, "resolved");
        assert.equal(request?.decision, "accept");
        // The answer goes to the child's provider, so its turn continues.
        const resolvedEvent = yield* orchestrator
          .streamStoredEventsFrom({
            threadId: childThreadId,
            afterSequence: 0,
            eventType: "runtime-request.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "runtime-request.updated" &&
                stored.event.payload.id === answeredHere.payload.id &&
                stored.event.payload.status === "resolved",
            ),
            Stream.runHead,
          );
        assert.ok(Option.isSome(resolvedEvent));
        const effects = yield* outbox.listByCommandId(resolvedEvent.value.commandId!);
        assert.deepInclude(
          effects.map((effect) => effect.request),
          {
            type: "runtime-request.respond",
            providerSessionId: ProviderSessionId.make(`session:${childThreadId}`),
            requestId: answeredHere.payload.id,
            decision: "accept",
          },
        );

        // Answered by the user first: the parent's queued wake is dropped.
        const answeredInUi = yield* ask("answered-in-ui");
        yield* reactor.handle(answeredInUi);
        const uiWake = yield* wakeFor(parentThreadId, answeredInUi.payload.id);
        assert.equal(uiWake.run?.status, "queued");
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("respond:ui"),
          threadId: childThreadId,
          requestId: answeredInUi.payload.id,
          decision: "decline",
        });
        yield* reactor.handle({
          ...answeredInUi,
          id: EventId.make("event:answered-in-ui-resolved"),
          payload: {
            ...answeredInUi.payload,
            status: "resolved",
            resolvedAt: answeredInUi.occurredAt,
          },
        });
        assert.equal(
          (yield* wakeFor(parentThreadId, answeredInUi.payload.id)).run?.status,
          "cancelled",
        );
        const late = yield* pendingRequest(parent, {
          action: "respond",
          threadId: childThreadId,
          requestId: answeredInUi.payload.id,
          decision: "accept",
        });
        assert.include(failure(late)?.message, "already answered");
      }),
    );

    it.effect("cannot be accepted by a parent whose modes would not allow it", () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const parentThreadId = yield* runningThread("supervised-lead", "approval-required");
        const { childThreadId, ask } = yield* childAskingApproval(
          parentThreadId,
          "approval-required",
        );
        const asked = yield* ask("supervised");
        const parent = threadScope(parentThreadId);
        const read = yield* pendingRequest(parent, {
          action: "read",
          threadId: childThreadId,
          requestId: asked.payload.id,
        });
        assert.deepEqual(
          (read.structuredContent as { approval: { decisions: unknown } }).approval.decisions,
          ["decline"],
        );
        for (const decision of ["accept", "acceptForSession"]) {
          const refused = yield* pendingRequest(parent, {
            action: "respond",
            threadId: childThreadId,
            requestId: asked.payload.id,
            decision,
          });
          assert.equal(failure(refused)?.code, "capability_denied", decision);
        }
        assert.equal(
          (yield* projections.getRuntimeRequest(childThreadId, asked.payload.id))?.status,
          "pending",
        );
        const declined = yield* pendingRequest(parent, {
          action: "respond",
          threadId: childThreadId,
          requestId: asked.payload.id,
          decision: "decline",
        });
        assert.equal(declined.isError, false, JSON.stringify(declined.content));
        assert.equal(
          (yield* projections.getRuntimeRequest(childThreadId, asked.payload.id))?.decision,
          "decline",
        );
      }),
    );

    it.effect("that the user's ask rule raised despite full access is left to the user", () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const parentThreadId = yield* runningThread("full-access-lead", "full-access");
        const { childThreadId, ask } = yield* childAskingApproval(parentThreadId, "full-access");
        const asked = yield* ask("ask-rule", "ask_rule");
        const parent = threadScope(parentThreadId);
        const read = yield* pendingRequest(parent, {
          action: "read",
          threadId: childThreadId,
          requestId: asked.payload.id,
        });
        assert.deepInclude((read.structuredContent as { approval: object }).approval, {
          fullAccessOverride: "ask_rule",
          decisions: ["decline"],
        });
        const refused = yield* pendingRequest(parent, {
          action: "respond",
          threadId: childThreadId,
          requestId: asked.payload.id,
          decision: "accept",
        });
        assert.equal(failure(refused)?.code, "capability_denied");
        assert.equal(
          (yield* projections.getRuntimeRequest(childThreadId, asked.payload.id))?.status,
          "pending",
        );
      }),
    );
    it.effect(
      "from a linked environment is answered only by the thread there that delegated it",
      () =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const childThreadId = "thread:laptop-task" as ThreadId;
          const delegatedFrom = {
            environmentId: EnvironmentId.make("environment:laptop"),
            threadId: "thread:laptop-lead" as ThreadId,
            title: "Laptop lead",
          };
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create:laptop-task"),
            threadId: childThreadId,
            projectId,
            title: "Laptop task",
            modelSelection,
            // Stepped down there: its provider offers no full access.
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            linkOrigin: { sessionId: "laptop", label: "T3 Code · laptop", access: "full-access" },
            delegatedFrom,
            createdBy: "agent",
            creationSource: "mcp",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start:laptop-task"),
            threadId: childThreadId,
            messageId: MessageId.make("message:laptop-task"),
            text: "Clean the build",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "agent",
            creationSource: "mcp",
          });
          const ask = yield* approvalAsker(childThreadId);
          // The laptop forwards its agent's call with that thread and its modes.
          const fromLaptop = (
            senderThread: typeof delegatedFrom,
            runtimeMode: RuntimeMode = "full-access",
            sessionId = "laptop",
          ): McpInvocationContext.McpInvocationScope => ({
            environmentId,
            requestNamespace: `client:${sessionId}`,
            thread: undefined,
            client: {
              sessionId,
              label: "T3 Code · laptop",
              access: "full-access",
              linked: true,
              senderThread,
              narrowedTo: { runtimeMode, interactionMode: "default" },
            },
            capabilities: new Set(["orchestration"]),
            issuedAt: 0,
          });
          const asked = yield* ask("from-laptop");
          const respond = (scope: McpInvocationContext.McpInvocationScope, decision: string) =>
            pendingRequest(scope, {
              action: "respond",
              threadId: childThreadId,
              requestId: asked.payload.id,
              decision,
            });

          const otherThread = { ...delegatedFrom, threadId: "thread:laptop-other" as ThreadId };
          assert.equal(
            failure(yield* respond(fromLaptop(otherThread), "accept"))?.code,
            "capability_denied",
          );
          assert.equal(
            failure(yield* respond(fromLaptop(delegatedFrom, "auto-accept-edits"), "accept"))?.code,
            "capability_denied",
          );
          // Another link naming the laptop's thread in its own sender header.
          assert.equal(
            failure(yield* respond(fromLaptop(delegatedFrom, "full-access", "desktop"), "accept"))
              ?.code,
            "capability_denied",
          );
          const accepted = yield* respond(fromLaptop(delegatedFrom), "accept");
          assert.equal(accepted.isError, false, JSON.stringify(accepted.content));
          assert.equal(
            (yield* projections.getRuntimeRequest(childThreadId, asked.payload.id))?.decision,
            "accept",
          );
        }),
    );
    it.effect("in another project here wakes the thread that delegated it, which answers it", () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
        const { parentThreadId, childThreadId } = yield* otherProjectTask(
          "cross-project",
          "always",
        );
        const ask = yield* approvalAsker(childThreadId);
        const asked = yield* ask("other-project");
        yield* reactor.handle(asked);
        const wake = yield* wakeFor(parentThreadId, asked.payload.id);
        assert.include(
          wake.message?.text,
          "blocked on a command approval: rm -rf build/other-project.",
        );
        assert.include(wake.message?.text, `threadId ${childThreadId}`);
        assert.notInclude(wake.message?.text, "environmentId");
        assert.equal(wake.run?.status, "queued");

        // A link's agent naming the local parent in its sender header neither sees nor answers it.
        const forged: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:laptop",
          thread: undefined,
          client: {
            sessionId: "laptop",
            label: "T3 Code · laptop",
            access: "full-access",
            linked: true,
            senderThread: { environmentId, threadId: parentThreadId, title: "cross-project-lead" },
          },
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const forgedList = yield* pendingRequest(forged, {
          action: "list",
          threadId: childThreadId,
        });
        assert.deepEqual(forgedList.structuredContent, { requestIds: [] });
        for (const args of [{ action: "read" }, { action: "respond", decision: "accept" }]) {
          const refused = yield* pendingRequest(forged, {
            ...args,
            threadId: childThreadId,
            requestId: asked.payload.id,
          });
          assert.equal(failure(refused)?.code, "capability_denied", args.action);
        }

        const accepted = yield* pendingRequest(threadScope(parentThreadId), {
          action: "respond",
          threadId: childThreadId,
          requestId: asked.payload.id,
          decision: "acceptForSession",
        });
        assert.equal(accepted.isError, false, JSON.stringify(accepted.content));
        assert.equal(
          (yield* projections.getRuntimeRequest(childThreadId, asked.payload.id))?.decision,
          "acceptForSession",
        );
      }),
    );

    it.effect("reaches a parent that waited for its task and gave up", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const reactor = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;

        // A blocking wait does not see a task in another project, so it is woken at once.
        const other = yield* otherProjectTask("waited-other", "settled_only");
        const otherAsked = yield* (yield* approvalAsker(other.childThreadId))("waited-other");
        yield* reactor.handle(otherAsked);
        assert.equal(
          (yield* wakeFor(other.parentThreadId, otherAsked.payload.id)).run?.status,
          "queued",
        );

        // Its own child's request waits for the blocking wait, which times out and lets the
        // task wake its parent; the parent's turn ending then delivers it.
        const parentThreadId = yield* runningThread("waited-lead", "full-access");
        const { task, ask } = yield* childAskingApproval(
          parentThreadId,
          "full-access",
          "settled_only",
        );
        const asked = yield* ask("waited");
        yield* reactor.handle(asked);
        assert.isUndefined((yield* wakeFor(parentThreadId, asked.payload.id)).message);
        yield* orchestrator.dispatch({
          type: "delegated_task.wake-policy",
          commandId: CommandId.make("wake-policy:waited"),
          parentThreadId,
          taskId: task.id,
          completionWake: "always",
        });
        const parentRun = (yield* projections.getThreadRecords(parentThreadId, ["runs"])).runs[0]!;
        yield* reactor.handle({
          id: EventId.make("event:waited-lead-ended"),
          type: "run.updated",
          threadId: parentThreadId,
          runId: parentRun.id,
          occurredAt: yield* DateTime.now,
          payload: { ...parentRun, status: "completed" },
        });
        assert.isDefined((yield* wakeFor(parentThreadId, asked.payload.id)).message);
      }),
    );
  },
);
