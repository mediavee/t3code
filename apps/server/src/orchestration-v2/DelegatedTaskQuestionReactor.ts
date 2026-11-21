import {
  CommandId,
  type EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  isParentWakeRequestKind,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

/** What a parent is told of one pending request of its task. */
export interface ParentWakeRequest {
  readonly id: RuntimeRequestId;
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  /** The task keeps working while it waits for an answer. */
  readonly answeredByMessage: boolean;
  readonly prompt?: string | undefined;
  readonly reason?: string | undefined;
}

export const parentWakeMessageId = (parentThreadId: ThreadId, requestId: RuntimeRequestId) =>
  MessageId.make(`message:delegated-task-question:${parentThreadId}:${requestId}`);

const clip = (text: string) => {
  const characters = Array.from(text.trim());
  return characters.length > 2000 ? `${characters.slice(0, 2000).join("")}…` : text.trim();
};

/**
 * The message that wakes a task's parent for one of its pending requests. `environmentId`
 * names the linked environment a task's thread runs in, which the parent must pass to answer.
 */
export const parentWakeCommand = (
  task: Pick<OrchestrationV2Subagent, "id" | "threadId" | "title" | "prompt">,
  childThreadId: ThreadId,
  request: ParentWakeRequest,
  environmentId?: EnvironmentId,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> => {
  const key = `${task.threadId}:${request.id}`;
  const label = reportLabel(task.title?.trim() || task.prompt);
  const where = `${environmentId === undefined ? "" : `environmentId ${environmentId}, `}threadId ${childThreadId}, and requestId ${request.id}`;
  const approval = request.kind !== "user_input";
  const situation = approval
    ? `Delegated task ${task.id} is blocked on a ${request.kind} approval${request.prompt?.trim() ? `: ${clip(request.prompt)}` : ""}.${request.reason?.trim() ? ` Reason: ${clip(request.reason)}` : ""}`
    : request.answeredByMessage
      ? `Delegated task ${task.id} asked a question and is still working.`
      : `Delegated task ${task.id} is blocked on a question and cannot continue until it is answered.`;
  const next = approval
    ? `Read it with t3_pending_request action read, ${where}, then respond with a \`decision\`. Accept only what the task needs and your own modes allow; otherwise decline it or ask the user, who can also answer it in that thread. If it is no longer pending, it was answered.`
    : `Read it with t3_pending_request action read, ${where}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`server:delegated-task-question:${key}`),
    threadId: task.threadId,
    messageId: parentWakeMessageId(task.threadId, request.id),
    text: `${situation} ${next}`,
    notification: {
      source: {
        kind: "delegated_task",
        taskIds: [task.id],
        ...(environmentId === undefined ? { childThreadId } : {}),
      },
      outcome: "updated",
      summary: `Delegated task${label === undefined ? "" : ` "${label}"`} ${approval ? "needs approval" : "has a question"}`,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "agent",
    creationSource: "server",
  };
};

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    childThreadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    const item =
      request.kind === "user_input"
        ? undefined
        : (yield* projections.getThreadRecords(childThreadId, ["turnItems"], {
            turnItemRequestIds: [request.id],
            turnItemTypes: ["approval_request"],
          })).turnItems.find((item) => item.type === "approval_request");
    yield* engine.dispatch(
      parentWakeCommand(task, childThreadId, {
        id: request.id,
        kind: request.kind,
        answeredByMessage: request.responseCapability.type === "message",
        ...(item?.type === "approval_request" ? { prompt: item.prompt, reason: item.reason } : {}),
      }),
    );
  });

  /** A task's thread here: its child, or the thread it runs as in another project here. */
  const childThreadOf = Effect.fnUntraced(function* (task: OrchestrationV2Subagent) {
    if (task.childThreadId !== null) return task.childThreadId;
    const remote = task.remoteChild;
    if (remote === undefined) return null;
    const shell = yield* projections.getThreadShell(remote.threadId);
    return shell?.delegatedFrom?.environmentId === remote.environmentId &&
      shell.delegatedFrom.threadId === task.threadId
      ? shell.id
      : null;
  });

  const cancelQueuedWakes = Effect.fnUntraced(function* (
    parentThreadId: ThreadId,
    requestIds: ReadonlyArray<RuntimeRequestId>,
  ) {
    const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
    for (const requestId of requestIds) {
      const key = `${parentThreadId}:${requestId}`;
      const messageId = parentWakeMessageId(parentThreadId, requestId);
      const queued = parent.runs.find(
        (run) => run.status === "queued" && run.userMessageId === messageId,
      );
      if (queued === undefined) continue;
      yield* engine
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
          threadId: parentThreadId,
          runId: queued.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("cancelling a delegated task question wake failed", {
              threadId: parentThreadId,
              requestId,
              cause,
            }),
          ),
        );
    }
  });

  // Runs for every domain event; most events return before any work is needed.
  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        // Catches up what a blocking wait held back, even after it gave up and changed the task's
        // wake; a request already woken keeps its wake's command id, so it is not woken twice.
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.runId !== event.payload.id ||
            task.completionDelivery?.state === "disposed" ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const childThreadId = yield* childThreadOf(task);
          if (childThreadId === null) continue;
          const child = yield* projections.getThreadRecords(childThreadId, ["runtimeRequests"]);
          for (const request of child.runtimeRequests) {
            if (
              !isParentWakeRequestKind(request.kind) ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task, childThreadId, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (
          task.origin !== "app_owned" ||
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        ) {
          return;
        }
        const childThreadId = yield* childThreadOf(task);
        if (childThreadId === null) return;
        // A settled task can no longer use an answer to its still-pending requests.
        const { runtimeRequests } = yield* projections.getThreadRecords(childThreadId, [
          "runtimeRequests",
        ]);
        const questions = runtimeRequests.filter((request) =>
          isParentWakeRequestKind(request.kind),
        );
        if (questions.length === 0) return;
        const child = yield* projections.getThreadRecords(childThreadId, ["runs", "nodes"]);
        const taskRunIds = new Set(
          child.runs
            .filter(
              (run) =>
                run.delegatedTaskId === task.id ||
                (task.childThreadId === null && run.id === task.remoteChild?.runId) ||
                (run.delegatedTaskId === undefined &&
                  child.thread.forkedFrom?.type === "node" &&
                  child.thread.forkedFrom.nodeId === task.id),
            )
            .map((run) => run.id),
        );
        const taskNodeIds = new Set(
          child.nodes
            .filter((node) => node.runId !== null && taskRunIds.has(node.runId))
            .map((node) => node.id),
        );
        yield* cancelQueuedWakes(
          task.threadId,
          questions
            .filter((request) => taskNodeIds.has(request.nodeId))
            .map((request) => request.id),
        );
        return;
      }
      if (
        event.type !== "runtime-request.updated" ||
        !isParentWakeRequestKind(event.payload.kind)
      ) {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = parentThreadOf(child);
      if (parentThreadId === null) return;
      // A task from a linked environment names a parent that is not here.
      if ((yield* projections.getThreadShell(parentThreadId)) === null) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        yield* cancelQueuedWakes(parentThreadId, [event.payload.id]);
        return;
      }
      const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
      const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
      const run =
        runs.find((run) => run.id === event.runId) ??
        runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      const taskId =
        run?.delegatedTaskId ??
        (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
      const from = child.delegatedFrom;
      // A task in another project here records the thread, and the run, it runs as.
      const adopted = parent.subagents
        .filter(
          (candidate) =>
            child.lineage.parentThreadId === null &&
            candidate.remoteChild?.threadId === child.id &&
            candidate.remoteChild.environmentId === from?.environmentId,
        )
        .toSorted(
          (a, b) =>
            Number(b.remoteChild?.runId === run?.id) - Number(a.remoteChild?.runId === run?.id),
        )[0];
      const task =
        parent.subagents.find(
          (candidate) => candidate.origin === "app_owned" && candidate.id === taskId,
        ) ?? (adopted?.origin === "app_owned" ? adopted : undefined);
      if (
        task === undefined ||
        parent.thread.archivedAt !== null ||
        parent.thread.deletedAt !== null
      ) {
        return;
      }
      // A blocking delegate_task wait delivers its own child's question; it cannot see another
      // project's thread.
      if (
        task.childThreadId !== null &&
        task.completionWake === "settled_only" &&
        event.payload.responseCapability.type === "live" &&
        parent.runs.some(
          (run) =>
            run.id === task.runId &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* wakeParent(task, child.id, request);
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("waking the parent of a delegated task question failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  // Every wake and cancel goes to the parent, so keying by it keeps a question's wake ahead of
  // its task's cancel while a busy parent's lock delays only that parent's reactions.
  const parentOf = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "run.updated":
        return Effect.succeed(event.threadId);
      case "subagent.updated":
        return Effect.succeed(event.payload.threadId);
      case "runtime-request.updated":
        return isParentWakeRequestKind(event.payload.kind)
          ? projections.getThread(event.threadId).pipe(Effect.map(parentThreadOf))
          : Effect.succeed(null);
      default:
        return Effect.succeed(null);
    }
  };

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = Effect.fn(
    "DelegatedTaskQuestionReactor.start",
  )(function* () {
    const parentReactions = yield* KeyedLock.makeRunner<ThreadId>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        parentOf(event).pipe(
          Effect.flatMap((parentThreadId) =>
            parentThreadId === null
              ? Effect.void
              : parentReactions.run(parentThreadId, handle(event)),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("finding the parent of a delegated task question failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

/** The thread that delegated this one: its lineage parent, or the thread named by `delegatedFrom`. */
const parentThreadOf = (child: Pick<OrchestrationV2AppThread, "lineage" | "delegatedFrom">) =>
  child.lineage.parentThreadId ?? child.delegatedFrom?.threadId ?? null;

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
