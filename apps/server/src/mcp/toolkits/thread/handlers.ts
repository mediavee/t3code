import {
  type CommandId,
  isProviderNativeSubagentThread,
  type OrchestrationV2AppThread,
  ProviderRequestKind,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type Caller,
  type CallerLimits,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import {
  providerOptionDescriptors,
  refuseAgentModePick,
  runtimeModeRank,
} from "../../delegatedTaskModes.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import type * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { rejectionText } from "../../../orchestration-v2/runOutput.ts";
import { PENDING_APPROVAL_DECISIONS, ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

/**
 * Places an agent pin at the top of the Pinned section, as a client pin is placed.
 * Without a key the sidebar sorts the pin below every keyed pin. Ordering is
 * best effort: if the index cannot be read, the pin still lands, keyless.
 */
const topOfPinnedRunKey = Effect.fn("mcp.topOfPinnedRunKey")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "listActiveShellIndex">,
) {
  const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => null));
  if (index === null) return undefined;
  const pinnedKeys = index.flatMap((entry) => (entry.pinnedAt == null ? [] : [entry.pinOrderKey]));
  return topOfPinnedRunOrderKey(pinnedKeys) ?? undefined;
});

type PendingDecision = (typeof PENDING_APPROVAL_DECISIONS)[number];

/**
 * A task the caller delegated: here, in another project here, or from the linked thread it acts
 * for. A linked caller's sender header is its own claim, so the child must also come from its link.
 */
const isCallersChild = (
  context: Caller,
  child: Pick<
    OrchestrationV2AppThread,
    "lineage" | "creationSource" | "delegatedFrom" | "linkOrigin"
  >,
) => {
  const from = child.delegatedFrom ?? undefined;
  if (context.caller !== undefined) {
    return (
      (child.lineage.parentThreadId === context.caller.id &&
        child.lineage.relationshipToParent === "subagent" &&
        !isProviderNativeSubagentThread(child)) ||
      (child.linkOrigin === undefined &&
        from?.environmentId === context.scope.environmentId &&
        from.threadId === context.caller.id)
    );
  }
  const client = context.scope.client?.linked === true ? context.scope.client : undefined;
  const sender = client?.senderThread;
  return (
    client !== undefined &&
    sender !== undefined &&
    child.linkOrigin?.sessionId === client.sessionId &&
    from?.environmentId === sender.environmentId &&
    from.threadId === sender.threadId
  );
};

/**
 * Whether the caller's own modes would let it do what the approval asks without asking. A request
 * that reached the user despite full access (their ask rule, a provider check) only the user accepts.
 */
const withinCallerModes = (
  limits: CallerLimits,
  item: { readonly requestKind: ProviderRequestKind; readonly fullAccessOverride?: unknown },
  decision: PendingDecision,
) =>
  decision === "decline" ||
  (item.fullAccessOverride === undefined &&
    limits.interactionMode === "default" &&
    (limits.runtimeMode === "full-access" ||
      ((item.requestKind === "file-change" || item.requestKind === "file-read") &&
        runtimeModeRank(limits.runtimeMode) >= runtimeModeRank("auto-accept-edits"))));

const isApprovalKind = Schema.is(ProviderRequestKind);

const PROMPT_LIMIT = 16000;
const truncated = (text: string | undefined) =>
  text === undefined ? undefined : Array.from(text).slice(0, PROMPT_LIMIT).join("");

const readRequest = Effect.fn("mcp.readPendingRequest")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"], {
    turnItemTypes: ["user_input_request", "approval_request"],
  });
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId,
  );
  const item = context.projection.turnItems.find(
    (item) =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === input.requestId,
  );
  if (request?.kind === "user_input" && item?.type === "user_input_request") {
    if (request.status !== "pending")
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          request.status === "resolved"
            ? "The user-input request was already answered."
            : `The user-input request is no longer pending (${request.status}).`,
      });
    return { ...context, request, item, decisions: [] as ReadonlyArray<PendingDecision> };
  }
  if (request === undefined || item?.type !== "approval_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (context.caller !== undefined && context.projection.thread.id === context.caller.id)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "An agent cannot answer an approval on its own thread. The user answers it there.",
    });
  if (!isCallersChild(context, context.projection.thread))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Only the thread that delegated this task can answer its approvals. The user can answer it in the thread.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The approval was already answered."
          : `The approval is no longer pending (${request.status}).`,
    });
  const offered = item.options?.map((option) => option.decision);
  const decisions = PENDING_APPROVAL_DECISIONS.filter(
    (decision) =>
      (offered === undefined || offered.includes(decision)) &&
      withinCallerModes(context.limits, item, decision),
  );
  return { ...context, request, item, decisions };
});
/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);
const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        lastRunError: task.lastRunError,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        currentThreadId: scope.thread?.threadId ?? null,
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId, match.title),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        return {
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const modelSelection = yield* required(input.modelSelection, "modelSelection");
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
        yield* refuseAgentModePick({
          callerRuntimeMode: (yield* readCaller()).limits.runtimeMode,
          picked: modelSelection.options,
          descriptors: providerOptionDescriptors(
            providers.find((provider) => provider.instanceId === modelSelection.instanceId),
          ),
          held:
            thread.modelSelection.instanceId === modelSelection.instanceId
              ? thread.modelSelection.options
              : undefined,
        });
        const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
        const result = yield* threads
          .dispatch({ type, threadId: thread.id, commandId: yield* newCommandId(), modelSelection })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const context = yield* readThread(input.threadId, ["runtimeRequests"]);
          const approvals =
            context.projection.thread.id !== context.caller?.id &&
            isCallersChild(context, context.projection.thread);
          return {
            requestIds: context.projection.runtimeRequests
              .filter(
                (request) =>
                  request.status === "pending" &&
                  (request.kind === "user_input" || (approvals && isApprovalKind(request.kind))),
              )
              .map((request) => request.id),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const read = yield* readRequest({ threadId: input.threadId, requestId });
        if (read.item.type === "user_input_request")
          return { requestId, questions: read.item.questions };
        const { requestKind, prompt, reason, appName, fullAccessOverride } = read.item;
        return {
          requestId,
          approval: {
            kind: requestKind,
            ...(prompt === undefined ? {} : { prompt: truncated(prompt) }),
            ...(reason === undefined ? {} : { reason: truncated(reason) }),
            ...(appName === undefined ? {} : { appName }),
            ...(fullAccessOverride === undefined ? {} : { fullAccessOverride }),
            decisions: read.decisions,
          },
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        const read = yield* readRequest({ threadId: input.threadId, requestId });
        let answer: { answers: ProviderUserInputAnswers } | { decision: PendingDecision };
        if (read.item.type === "user_input_request") {
          answer = { answers: yield* required(input.answers, "answers") };
        } else {
          const decision = yield* required(input.decision, "decision");
          if (!read.decisions.includes(decision)) {
            const { runtimeMode, interactionMode } = read.limits;
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: `This caller cannot ${decision} this ${read.item.requestKind} approval: its ${runtimeMode}/${interactionMode} modes would not let it do that itself, or the provider does not offer it. It may: ${read.decisions.join(", ") || "nothing"}. Otherwise ask the user to answer it in the thread.`,
            });
          }
          answer = { decision };
        }
        const result = yield* read.threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: read.projection.thread.id,
            commandId: yield* newCommandId(),
            requestId,
            ...answer,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_submit_output: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      if (scope.thread === undefined) return yield* unavailable();
      return yield* threads
        .submitRunOutput({
          threadId: scope.thread.threadId,
          commandId: yield* newCommandId(),
          json: input.json,
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementRunOutputRejectedError"
              ? new OrchestratorMcpFailure({
                  code: "invalid_request",
                  // The agent wrote the value, so it is told what in it did not fit.
                  message: rejectionText(error),
                })
              : unavailable(),
          ),
        );
    }),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { threads, projection: queued } = yield* readThread(input.threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        const messages = yield* threads
          .getMessagesById(
            queued.thread.id,
            queued.runs.map((run) => run.userMessageId),
          )
          .pipe(Effect.mapError(unavailable));
        const projection = { runs: queued.runs, messages: [...messages.values()] };
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            const { threads, projection } = yield* readThread(input.threadId);
            // An agent must not turn a person's queued message into a provider sign-out.
            const command = yield* ThreadMessageIntake.withQueuedAttachmentsOnSignOutText({
              type: "queued-run.edit",
              commandId: yield* newCommandId(),
              threadId: projection.thread.id,
              runId,
              text,
            }).pipe(
              Effect.mapError((error) =>
                error._tag === "EnvironmentAuthorizationError"
                  ? new OrchestratorMcpFailure({
                      code: "invalid_request",
                      message: "A queued message cannot be edited into a provider sign-out.",
                    })
                  : dispatchFailure(error),
              ),
            );
            const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence };
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "pin": {
          // Always send a key, as the client does: the reducer ignores it for a
          // thread that is already pinned, and a projection read before this
          // command can be stale if an unpin commits in between.
          const orderKey = yield* topOfPinnedRunKey(threads);
          command = { ...common, type: "thread.pin", ...(orderKey ? { orderKey } : {}) };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
