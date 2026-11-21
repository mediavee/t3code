import {
  CommandId,
  type EnvironmentId,
  latestProviderTurnForAttempt,
  type ModelSelection,
  NodeId,
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpThreadWaitResult,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2RemoteTaskWorktree,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type RunId,
  type RuntimeRequestId,
  type ThreadId,
  type OrchestratorMcpThreadBackgroundTask,
} from "@t3tools/contracts";
import { withDelegatedChildCommandsLeftRunning } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";
import {
  delegatedTaskReportRuns,
  subagentResultForRun,
  withExecutedModelNote,
} from "@t3tools/provider-core/server/subagentProjection";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ProjectToolkit } from "../mcp/toolkits/project/tools.ts";
import {
  providerOptionDescriptors,
  resolveInteractionMode,
  resolveRuntimeMode,
  taskPrompt,
  withoutAgentModePicks,
} from "../mcp/delegatedTaskModes.ts";
import { followUpOwnerRun } from "../orchestration-v2/CommandPolicy.ts";
import {
  parentWakeCommand,
  parentWakeMessageId,
} from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as KnownSecrets from "../secrets/KnownSecrets.ts";
import { redactSecrets } from "../secrets/secretRedaction.ts";
import { forkParked } from "../serverActivation.ts";
import * as PeerForwarding from "./PeerForwarding.ts";
import * as PeerLinks from "./PeerLinks.ts";

/** How long one follow of a remote task waits on its thread there before checking again. */
const FOLLOW_WAIT_MS = 10 * 60 * 1_000;
/** A linked environment that stops answering is retried, backing off to this. */
const FOLLOW_MAX_BACKOFF = Duration.minutes(5);
/** A follower that hits this many defects in a row fails its task instead of retrying. */
const FOLLOW_MAX_DEFECTS = 3;
/** How a follower retries; tests step it by hand. */
export const FollowRetrySchedule = Context.Reference<Schedule.Schedule<unknown>>(
  "t3/peer/RemoteDelegation/FollowRetrySchedule",
  {
    defaultValue: () =>
      Schedule.exponential(Duration.seconds(2)).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, FOLLOW_MAX_BACKOFF)),
        ),
      ),
  },
);

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;

/** How a task whose thread runs in this environment names where it runs. */
const LOCAL_LABEL = "this environment";

/** `orchestrator_capabilities` there. Its toolkit imports this module, so it is described here. */
const RemoteCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
});

/**
 * `delegate_task` to a linked environment. The task's child is an ordinary
 * thread there, launched through the link; the parent here records the task
 * like a local one, without a child thread, and a follower completes it when
 * the thread there ends, so the parent wakes as it would for a local child.
 */
export class RemoteDelegation extends Context.Service<
  RemoteDelegation,
  {
    readonly delegate: (
      scope: ThreadScope,
      input: OrchestratorMcpDelegateTaskInput & {
        readonly target: NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
          readonly environmentId: EnvironmentId;
        };
      },
    ) => Effect.Effect<
      {
        readonly taskId: NodeId;
        readonly runtimeModeSteppedDown?: OrchestratorMcpDelegateTaskResult["runtimeModeSteppedDown"];
      },
      OrchestratorMcpFailure
    >;
    /**
     * Records a thread already launched here, in another project, as a task of the calling
     * thread's active run, and follows it as a task there would be: its end wakes the parent,
     * and the parent's stop, cancel and end reach it without a link.
     */
    readonly adoptLocal: (
      scope: ThreadScope,
      input: {
        readonly parentRunId: RunId;
        readonly parentNodeId: NodeId;
        readonly key: string;
        readonly task: string;
        readonly title?: string | undefined;
        readonly driver: ProviderDriverKind;
        readonly modelSelection: ModelSelection;
        readonly child: {
          readonly threadId: ThreadId;
          readonly title: string;
          readonly runId: RunId | null;
        };
        readonly completionWake: "always" | "settled_only";
      },
    ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
    /**
     * A `t3_thread_send` there that started or queued a run on the thread of
     * one of this thread's tasks that has its result: like a follow-up to a
     * finished child here, that run is a new task, whose id the send returns.
     * Any other send is returned as it came.
     */
    readonly followUp: (
      scope: McpInvocationContext.McpInvocationScope,
      environmentId: EnvironmentId,
      request: Pick<OrchestratorMcpThreadSendInput, "message" | "clientRequestId">,
      sent: OrchestratorMcpThreadSendResult,
    ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
    /**
     * Stops the task's thread there, then completes it here as cancelled. A
     * task that already has its result keeps it; its thread there is still
     * stopped, as cancelling a local task stops follow-up work on its child.
     */
    readonly cancel: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
      input: {
        readonly reason?: string | undefined;
        readonly clientRequestId?: string | undefined;
      },
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    /**
     * The status of the task's run there and the checkout it has there of its own, or null when
     * it cannot be read: an unreachable machine reads as no news rather than failing the read here.
     */
    readonly readThere: (
      scope: ThreadScope,
      task: OrchestrationV2Subagent,
    ) => Effect.Effect<{
      readonly status: OrchestratorMcpThreadRun["status"] | null;
      readonly worktree: OrchestrationV2RemoteTaskWorktree | null;
    } | null>;
    /**
     * Follows every open remote task until it ends, including after a
     * restart, and a finished one again when a Stop here owes it a stop there.
     * Tells the thread there of each task a settled, archived or deleted parent
     * here delegated that the parent is done, until it has it.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/RemoteDelegation") {}

/** The other side refused because the thread there runs above this caller's modes. */
const isModeRefusal = (error: OrchestratorMcpFailure) =>
  error.code === "runtime_mode_escalation_denied" ||
  error.code === "interaction_mode_escalation_denied";

/**
 * Refusals that following again cannot change: the link was revoked, expired
 * or forgotten, or the thread or run there is gone. Anything else (the other
 * machine asleep, a dropped route) is worth retrying.
 */
const isFinal = (error: OrchestratorMcpFailure) =>
  error.code === "capability_denied" ||
  error.code === "thread_not_found" ||
  error.code === "run_not_found";

const make = Effect.gen(function* () {
  const followRetry = yield* FollowRetrySchedule;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const random = yield* SecureRandom.SecureRandom;
  const knownSecrets = yield* KnownSecrets.KnownSecrets;
  const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  // Followers live as long as this service, so shutting down stops them.
  const followers = yield* Scope.Scope;

  // One follower runs per open task and holds what it read across a wait of
  // up to FOLLOW_WAIT_MS, so it reads its own task, never the parent's whole
  // task list: a parent with thousands of tasks made every restart decode
  // that list once per open task at the same time and ran out of heap.
  const readTask = (parentThreadId: ThreadId, taskId: NodeId) =>
    threads
      .getThreadRecords(parentThreadId, ["subagents"], { subagentIds: [taskId] })
      .pipe(Effect.map(({ thread, subagents }) => ({ thread, task: subagents[0] })));

  const isHere = (remote: Pick<OrchestrationV2RemoteTaskChild, "environmentId">) =>
    remote.environmentId === hereId;

  /** A thread gone here can never be followed again; anything else is worth retrying. */
  const localFailure = (error: { readonly _tag: string; readonly message: string }) =>
    new OrchestratorMcpFailure({
      code:
        error._tag === "ThreadManagementThreadNotFoundError"
          ? "thread_not_found"
          : error._tag === "ThreadManagementRunNotFoundError"
            ? "run_not_found"
            : "orchestration_error",
      message: error.message,
    });

  /** `t3_thread_wait` on a task's thread here, in the shape a wait there returns. */
  const waitHere = Effect.fn("RemoteDelegation.waitHere")(function* (
    remote: OrchestrationV2RemoteTaskChild,
  ) {
    const shell = yield* threads
      .getThreadShell(remote.threadId)
      .pipe(Effect.mapError(localFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: `The task's thread ${remote.threadId} was deleted.`,
      });
    }
    const waited = yield* threads
      .waitForThread({
        projectId: shell.projectId,
        threadId: remote.threadId,
        ...(remote.runId === undefined ? {} : { runId: remote.runId }),
        timeoutMs: FOLLOW_WAIT_MS,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.mapError(localFailure));
    const result: OrchestratorMcpThreadWaitResult = {
      threadId: remote.threadId,
      timedOut: waited.timedOut,
      runId: waited.run?.id ?? null,
      status: waited.run === null ? "idle" : runOutcome(waited.run),
      ...(waited.resultRun === undefined
        ? {}
        : { resultRun: { runId: waited.resultRun.id, status: runOutcome(waited.resultRun) } }),
    };
    return result;
  });

  /** The result `runId` gave on a task's thread here, as a local task's result is read. */
  const lastReplyHere = Effect.fn("RemoteDelegation.lastReplyHere")(function* (
    remote: OrchestrationV2RemoteTaskChild,
    runId: RunId | null,
    failed: boolean,
  ) {
    const { runs, providerThreads } = yield* threads.getThreadRecords(remote.threadId, [
      "runs",
      "providerThreads",
    ]);
    const run =
      runId === null
        ? runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]
        : runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return { text: undefined, executedModel: undefined };
    // A completed run that said nothing takes its report from the earlier runs of its task.
    const resultRuns = [run, ...delegatedTaskReportRuns({ runs, messages: [] }, run)];
    const resultRunIds = resultRuns.map((candidate) => candidate.id);
    const records = yield* threads.getThreadRecords(
      remote.threadId,
      ["messages", "turnItems", "providerTurns"],
      {
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error", "system_notice"],
        providerTurnAttemptIds: resultRuns.flatMap((candidate) =>
          candidate.activeAttemptId === null ? [] : [candidate.activeAttemptId],
        ),
      },
    );
    const text = subagentResultForRun({ ...records, runs: resultRuns }, run).text;
    return {
      // A hold that ran out leaves these running, as a result read there names them.
      text: failed
        ? text
        : withDelegatedChildCommandsLeftRunning(
            text,
            providerThreads.flatMap((thread) => thread.pendingBackgroundTasks ?? []),
          ),
      executedModel: latestProviderTurnForAttempt(records.providerTurns, run.activeAttemptId)
        ?.model,
    };
  }, Effect.mapError(localFailure));

  /** What the peer route does for a parent there, done here for a parent in this environment. */
  const tellParentDoneHere = (threadId: ThreadId, parentThreadId: ThreadId) =>
    random.uuidV4().pipe(
      // Each telling is its own command: a parent done again after a follow-up must reach it.
      Effect.flatMap((attempt) =>
        threads.dispatch({
          type: "thread.delegated-from.parent-done",
          commandId: CommandId.make(`command:local-parent-done:${attempt}`),
          threadId,
          parent: { environmentId: hereId, threadId: parentThreadId },
        }),
      ),
      Effect.as("told" as const),
      // A thread deleted here, or no longer this parent's task, is owed nothing.
      Effect.catchTags({ OrchestratorDispatchError: () => Effect.succeed("told" as const) }),
    );

  /** The peer's project with this thread's repository, or the one the caller named. */
  const resolveRemoteProject = Effect.fn("RemoteDelegation.resolveRemoteProject")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    parentProjectId: ProjectId,
    requested: ProjectId | undefined,
  ) {
    if (requested !== undefined) return requested;
    const here = yield* projects.getById(parentProjectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    // The project's own identity is a one-minute cache that reads blank when
    // cold, so resolve it here, as the other side's t3_project_list does.
    const key =
      here === undefined
        ? undefined
        : (yield* repositoryIdentities.resolve(here.workspaceRoot))?.canonicalKey;
    if (key === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "target_required",
        message: "Pass target.projectId: this thread's project has no repository to match there.",
      });
    }
    const matches: Array<{ readonly id: ProjectId; readonly title: string }> = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const listed: Tool.Success<typeof ProjectToolkit.tools.t3_project_list> =
        yield* forwarding.call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          cursor,
          limit: 100,
        });
      matches.push(
        ...listed.projects.filter((project) => project.repositoryIdentity?.canonicalKey === key),
      );
      cursor = listed.nextCursor;
    }
    if (matches.length === 1) return matches[0]!.id;
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        matches.length === 0
          ? `No project there has this repository (${key}). Pass target.projectId; t3_project_list with this environmentId lists them. To bring the repository there, use t3_project_clone and then t3_project_create with this environmentId.`
          : `Several projects there have this repository: ${matches.map((project) => `${project.title} (${project.id})`).join(", ")}. Pass target.projectId.`,
    });
  });

  /** The instance there of the driver the caller named, preferring the one this thread runs on, as a task here does. */
  const resolveRemoteInstance = Effect.fn("RemoteDelegation.resolveRemoteInstance")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    requested: {
      readonly driverKind: ProviderDriverKind;
      readonly providerInstanceId: ProviderInstanceId | undefined;
      readonly inheritedInstanceId: ProviderInstanceId;
    },
  ) {
    const { providers } = yield* forwarding.call(scope, RemoteCapabilitiesTool, environmentId, {});
    if (requested.providerInstanceId !== undefined) {
      const named = providers.find(
        (provider) => provider.providerInstanceId === requested.providerInstanceId,
      );
      if (named !== undefined && named.driverKind !== requested.driverKind) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Provider instance ${named.providerInstanceId} there uses driver ${named.driverKind}, not ${requested.driverKind}.`,
        });
      }
      return requested.providerInstanceId;
    }
    const candidates = providers.filter(
      (provider) => provider.driverKind === requested.driverKind && provider.canRunChildTask,
    );
    const chosen =
      candidates.find(
        (provider) => provider.providerInstanceId === requested.inheritedInstanceId,
      ) ?? candidates[0];
    if (chosen === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "provider_unavailable",
        message: `No instance of driver ${requested.driverKind} there can run a child task. orchestrator_capabilities with this environmentId lists its providers.`,
      });
    }
    return chosen.providerInstanceId;
  });

  /**
   * The new checkout's base, resolved and checked there: a commit only this checkout has would
   * not resolve there, and an older peer would silently put the task in the shared checkout.
   */
  const remoteWorktreeBase = Effect.fn("RemoteDelegation.remoteWorktreeBase")(function* (
    scope: ThreadScope,
    environmentId: EnvironmentId,
    projectId: ProjectId,
    baseRef: string | undefined,
  ) {
    const base = yield* forwarding.worktreeBase(scope, environmentId, {
      projectId,
      ...(baseRef === undefined ? {} : { baseRef }),
    });
    if (base.outcome === "resolved") {
      return {
        type: "worktree" as const,
        baseRef: base.baseRef,
        startFromOrigin: base.startFromOrigin,
      };
    }
    return yield* new OrchestratorMcpFailure({
      code: base.outcome === "refused" ? "capability_denied" : "invalid_request",
      message:
        base.outcome === "base_not_found" && baseRef !== undefined
          ? `${base.message} No task was started. A commit that exists only here is not there: push it, or omit baseRef to start from that project's default branch.`
          : `${base.message} No task was started.`,
    });
  });

  const delegate: RemoteDelegation["Service"]["delegate"] = Effect.fn("RemoteDelegation.delegate")(
    function* (scope, input) {
      const parent = yield* threads.getThreadRecords(scope.thread.threadId, ["runs"]).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The calling thread was not found.",
            }),
        ),
      );
      const parentRun = parent.runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Delegated tasks require an active run owned by this MCP provider session.",
        });
      }
      const parentNodeId = parentRun.rootNodeId;
      const { target } = input;
      if (input.baseRef !== undefined && input.isolation !== "worktree") {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: 'baseRef starts a new checkout there, so it needs isolation "worktree".',
        });
      }
      // The provider and model inherit as they do for a task here. Another
      // provider there has no model to inherit, so the caller names one.
      const inherited = parent.thread.modelSelection;
      const instanceId =
        target.driverKind === undefined
          ? (target.providerInstanceId ?? inherited.instanceId)
          : yield* resolveRemoteInstance(scope, target.environmentId, {
              driverKind: target.driverKind,
              providerInstanceId: target.providerInstanceId,
              inheritedInstanceId: inherited.instanceId,
            });
      const model =
        target.model ?? (instanceId === inherited.instanceId ? inherited.model : undefined);
      if (model === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass target.model from orchestrator_capabilities with this environmentId.",
        });
      }
      const inheritedOptions =
        instanceId === inherited.instanceId && model === inherited.model
          ? inherited.options
          : undefined;
      // Only full access may pick an agent's own mode there, and the other side cannot see
      // that this thread already runs in one. Below that the task starts in the agent's default.
      const options =
        target.options ??
        (inheritedOptions === undefined ||
        (parent.thread.runtimeMode === "full-access" &&
          (yield* links.get(target.environmentId).pipe(
            Effect.map((link) => Option.getOrUndefined(link)?.access === "full-access"),
            Effect.orElseSucceed(() => false),
          )))
          ? inheritedOptions
          : withoutAgentModePicks(
              inheritedOptions,
              providerOptionDescriptors(
                (yield* providerRegistry.getProviders).find(
                  (provider) => provider.instanceId === instanceId,
                ),
              ),
            ));
      // Modes asked for are checked against this thread. Omitted ones are left
      // to the other side, which inherits this thread's modes capped by the
      // link's access, so a narrower link still takes the task.
      const runtimeMode =
        input.runtimeMode === undefined || input.runtimeMode === "inherit"
          ? undefined
          : yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode);
      const interactionMode =
        input.interactionMode === undefined || input.interactionMode === "inherit"
          ? undefined
          : yield* resolveInteractionMode(parent.thread.interactionMode, input.interactionMode);
      const projectId = yield* resolveRemoteProject(
        scope,
        target.environmentId,
        parent.thread.projectId,
        target.projectId,
      );
      const workspaceStrategy =
        input.isolation === "worktree"
          ? yield* remoteWorktreeBase(scope, target.environmentId, projectId, input.baseRef)
          : undefined;
      // One key for the launch there and the record here, so a retry finds both.
      // Both are scoped to the provider session, as every key a caller passes is:
      // the forwarder scopes the launch's, and the record's names it.
      const key = input.clientRequestId ?? (yield* random.uuidV4());
      const task = taskPrompt(input);
      const title = input.title ?? parent.thread.title;
      const launched = yield* forwarding.call(
        scope,
        ProjectToolkit.tools.t3_thread_launch,
        target.environmentId,
        {
          projectId,
          title,
          modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
          ...(interactionMode === undefined ? {} : { interactionMode }),
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          message: task,
          clientRequestId: `delegate:${scope.thread.threadId}:${key}`,
          // The thread there shows it is this thread's subagent, with a way back.
          delegatedFrom: {
            environmentId: hereId,
            threadId: parent.thread.id,
            title: parent.thread.title,
          },
        },
      );
      const link = yield* links.get(target.environmentId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const remoteChild: OrchestrationV2RemoteTaskChild = {
        environmentId: target.environmentId,
        threadId: launched.threadId,
        label: link?.label ?? target.environmentId,
        title,
        ...(launched.runId === null ? {} : { runId: launched.runId }),
      };
      const { taskId } = yield* record(scope, {
        commandId: CommandId.make(
          `command:mcp:${encodeURIComponent(scope.requestNamespace)}:remote-delegate:${encodeURIComponent(key)}`,
        ),
        parentRunId: parentRun.id,
        parentNodeId,
        task,
        ...(input.title === undefined ? {} : { title: input.title }),
        // The driver runs there; this side only labels the task with it.
        driver: ProviderDriverKind.make("remote"),
        modelSelection: launched.modelSelection,
        remoteChild,
        completionWake: input.mode === "wait" ? "settled_only" : "always",
      });
      const { runtimeModeSteppedDown } = launched;
      return {
        taskId,
        ...(runtimeModeSteppedDown === undefined ? {} : { runtimeModeSteppedDown }),
      };
    },
  );

  /** Records the launched thread as a task of the caller's run, then follows it. */
  const record = Effect.fn("RemoteDelegation.record")(function* (
    scope: ThreadScope,
    input: {
      readonly commandId: CommandId;
      readonly parentRunId: RunId;
      readonly parentNodeId: NodeId;
      readonly task: string;
      readonly title?: string;
      readonly driver: ProviderDriverKind;
      readonly modelSelection: ModelSelection;
      readonly remoteChild: OrchestrationV2RemoteTaskChild;
      readonly completionWake: "always" | "settled_only";
    },
  ) {
    const { remoteChild } = input;
    const recorded = yield* threads
      .dispatch({
        type: "delegated_task.remote.request",
        commandId: input.commandId,
        parentThreadId: scope.thread.threadId,
        parentRunId: input.parentRunId,
        parentNodeId: input.parentNodeId,
        task: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        driver: input.driver,
        modelSelection: input.modelSelection,
        remoteChild,
        completionWake: input.completionWake,
      })
      .pipe(
        // The cause goes to the log; the caller learns only that recording failed.
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.record-failed", {
            parentThreadId: scope.thread.threadId,
            cause,
          }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the delegated task.",
            }),
        ),
        // Nothing here follows a thread the task was never recorded for, so stop it there.
        // A crash between the launch and this record still leaves it running there
        // until a retry with the same clientRequestId records it.
        Effect.tapError(() =>
          stopThere(followScope(scope.thread, remoteChild), remoteChild, "stop").pipe(
            Effect.ignoreCause({ log: true }),
          ),
        ),
      );
    const taskEvent = recorded.storedEvents.find(
      (stored) => stored.event.type === "subagent.updated",
    );
    const taskId =
      taskEvent?.event.type === "subagent.updated"
        ? taskEvent.event.payload.id
        : // A replayed request recorded the task the first time.
          yield* threads.getThreadRecords(scope.thread.threadId, ["subagents"]).pipe(
            Effect.map(
              ({ subagents }) =>
                subagents.find((task) => task.remoteChild?.threadId === remoteChild.threadId)?.id,
            ),
            Effect.orElseSucceed(() => undefined),
          );
    if (taskId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The delegated task was not recorded.",
      });
    }
    yield* followOne(scope.thread.threadId, taskId).pipe(Effect.forkIn(followers));
    return { taskId };
  });

  const adoptLocal: RemoteDelegation["Service"]["adoptLocal"] = (scope, input) =>
    record(scope, {
      commandId: CommandId.make(
        `command:mcp:${encodeURIComponent(scope.requestNamespace)}:local-delegate:${encodeURIComponent(input.key)}`,
      ),
      parentRunId: input.parentRunId,
      parentNodeId: input.parentNodeId,
      task: input.task,
      ...(input.title === undefined ? {} : { title: input.title }),
      driver: input.driver,
      modelSelection: input.modelSelection,
      remoteChild: {
        environmentId: hereId,
        threadId: input.child.threadId,
        label: LOCAL_LABEL,
        title: input.child.title,
        ...(input.child.runId === null ? {} : { runId: input.child.runId }),
      },
      completionWake: input.completionWake,
    });

  const followUp: RemoteDelegation["Service"]["followUp"] = Effect.fn("RemoteDelegation.followUp")(
    function* (scope, environmentId, request, sent) {
      // A steer joins a run that is already some task's, or no one's.
      if (scope.thread === undefined || (sent.delivery !== "started" && sent.delivery !== "queued"))
        return sent;
      const parentThreadId = scope.thread.threadId;
      const parent = yield* threads
        .getThreadRecords(parentThreadId, ["runs", "subagents"])
        .pipe(Effect.orElseSucceed(() => undefined));
      const isThere = (task: OrchestrationV2Subagent) =>
        task.remoteChild?.environmentId === environmentId &&
        task.remoteChild.threadId === sent.threadId;
      const finished = parent?.subagents.find((task) => isThere(task) && task.result !== null);
      // Bound as a follow-up here is: a background caller's foreground run may have ended.
      const parentRun = parent === undefined ? null : followUpOwnerRun(parent.runs);
      if (
        finished?.remoteChild === undefined ||
        finished.model === null ||
        parentRun === null ||
        parentRun.rootNodeId === null
      )
        return sent;
      // The message id there is the send's, so a retry that reached the same send records once.
      const commandId = CommandId.make(
        `command:remote-followup:${encodeURIComponent(parentThreadId)}:${encodeURIComponent(environmentId)}:${encodeURIComponent(sent.messageId)}`,
      );
      const recorded = yield* threads
        .dispatch({
          type: "delegated_task.remote.request",
          commandId,
          parentThreadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: request.message,
          ...(finished.title === null ? {} : { title: finished.title }),
          driver: finished.driver,
          modelSelection: { instanceId: finished.providerInstanceId, model: finished.model },
          remoteChild: {
            environmentId,
            threadId: sent.threadId,
            label: finished.remoteChild.label,
            runId: sent.runId,
          },
          completionWake: "always",
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("remote-delegation.followup-record-failed", {
              parentThreadId,
              cause,
            }),
          ),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  request.clientRequestId === undefined
                    ? "The message was sent, but its task was not recorded; read the thread for its answer instead of sending it again."
                    : "The message was sent, but its task was not recorded; send it again with the same clientRequestId to record it.",
              }),
          ),
        );
      const taskEvent = recorded.storedEvents.find(
        (stored) => stored.event.type === "subagent.updated",
      );
      const taskId =
        taskEvent?.event.type === "subagent.updated"
          ? taskEvent.event.payload.id
          : // A replayed request recorded the task the first time.
            yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
              Effect.map(
                ({ subagents }) =>
                  subagents.find((task) => isThere(task) && task.remoteChild?.runId === sent.runId)
                    ?.id,
              ),
              Effect.orElseSucceed(() => undefined),
            );
      if (taskId === undefined) return sent;
      yield* followOne(parentThreadId, taskId).pipe(Effect.forkIn(followers));
      return { ...sent, taskId };
    },
  );

  /**
   * Completes `task` here with its thread there's final state. Each attempt is its own
   * command, so a failed one never blocks the next; a report refused because the task already
   * has its result (a cancel, a Stop or an earlier report) is done. `stoppedThere` records that
   * nothing is left to stop there, even on a task that already has its result.
   */
  const complete = Effect.fn("RemoteDelegation.complete")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    result: string,
    stoppedThere: "ran-out" | "stopped" | undefined,
    stopCount?: number,
    executedModel?: string,
    worktree?: OrchestrationV2RemoteTaskWorktree,
  ) {
    const attempt = yield* random.uuidV4();
    const known = yield* knownSecrets.current;
    yield* threads
      .dispatch({
        type: "delegated_task.remote.complete",
        commandId: CommandId.make(`command:remote-task-complete:${taskId}:${attempt}`),
        parentThreadId,
        taskId,
        status,
        // A report from another environment can quote a secret this one handed out.
        result: known === null ? result : redactSecrets(result, known),
        ...(stoppedThere === undefined ? {} : { stoppedThere }),
        ...(stopCount === undefined ? {} : { stopCount }),
        ...(executedModel === undefined ? {} : { executedModel }),
        ...(worktree === undefined ? {} : { worktree }),
      })
      .pipe(
        Effect.catch((error) =>
          readTask(parentThreadId, taskId).pipe(
            Effect.flatMap(({ task }) => (task?.result != null ? Effect.void : Effect.fail(error))),
          ),
        ),
      );
  });

  /**
   * How this environment reaches a task's thread there: as the parent
   * thread, under one namespace per parent, so a stop sent again after a
   * restart or a dropped route is recorded there once.
   */
  const followScope = (
    parent: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
    remote: OrchestrationV2RemoteTaskChild,
  ): ThreadScope => ({
    environmentId: hereId,
    requestNamespace: `remote-task:${parent.threadId}`,
    thread: {
      threadId: parent.threadId,
      providerSessionId: `remote-task:${remote.threadId}`,
      providerInstanceId: parent.providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });

  /**
   * A deleted parent can no longer call as a thread, so what its task there is still owed goes
   * as a client held to the modes the parent had.
   */
  const deletedParentScope = (
    parent: Pick<
      OrchestrationV2ThreadShell,
      "id" | "title" | "providerInstanceId" | "runtimeMode" | "interactionMode"
    >,
    remote: OrchestrationV2RemoteTaskChild,
  ): McpInvocationContext.McpInvocationScope => ({
    ...followScope({ threadId: parent.id, providerInstanceId: parent.providerInstanceId }, remote),
    thread: undefined,
    client: {
      sessionId: `remote-task:${parent.id}`,
      label: parent.title,
      access: parent.runtimeMode,
      narrowedTo: { runtimeMode: parent.runtimeMode, interactionMode: parent.interactionMode },
    },
  });

  /**
   * Stops the task's own thread there as its Stop button does: its running turn, queued
   * messages, pull request watches and delegated tasks. `key` names the stop (the follower
   * sends one, each cancel its own), and each is recorded there once however often it is sent.
   * A cancel here also drops the turns agents queued on it, as `task_cancel` does locally.
   */
  const stopThere = (
    scope: McpInvocationContext.McpInvocationScope,
    remote: OrchestrationV2RemoteTaskChild,
    key: string,
    reason?: string,
    cancelAgentMessages = false,
  ) =>
    isHere(remote)
      ? threads
          .dispatch({
            type: "thread.stop",
            // One id per stop, so sending it again records it once.
            commandId: CommandId.make(
              `command:local-task-stop:${encodeURIComponent(`${key}:${remote.threadId}`)}`,
            ),
            threadId: remote.threadId,
            ...(reason === undefined ? {} : { reason }),
            ...(cancelAgentMessages ? { cancelAgentMessages } : {}),
          })
          .pipe(Effect.asVoid, Effect.mapError(localFailure))
      : forwarding
          .interruptThread(scope, remote.environmentId, {
            threadId: remote.threadId,
            stop: true,
            ...(reason === undefined ? {} : { reason }),
            clientRequestId: `${key}:${remote.threadId}`,
          })
          .pipe(Effect.asVoid);

  /**
   * The last reply `runId` gave on the task's thread there, which is its
   * result, read whole however long it is. A failed run prefers its error
   * from the activity view over an earlier reply, without taking another run's.
   * Led by a note when its provider reported running another model than it asked for.
   */
  const lastReply = Effect.fn("RemoteDelegation.lastReply")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    remote: OrchestrationV2RemoteTaskChild,
    runId: RunId | null,
    failed = false,
    probeSuccess = true,
  ) {
    // A task here has no checkout there to report.
    if (isHere(remote))
      return { ...(yield* lastReplyHere(remote, runId, failed)), worktree: undefined };
    let reply: OrchestratorMcpThreadTimelineItem | undefined;
    let error: OrchestratorMcpThreadTimelineItem | undefined;
    // Linked peers read newest first without a cursor, so this scan runs forward. It starts
    // after position 0, the message that started the thread, which no run's reply can precede;
    // older peers refuse -1.
    let afterPosition = 0;
    let run: OrchestratorMcpThreadRun | undefined;
    let remainingItems = 0;
    let tailProbed = false;
    let backgroundTasks: ReadonlyArray<OrchestratorMcpThreadBackgroundTask> = [];
    let worktree: OrchestrationV2RemoteTaskWorktree | undefined;
    let firstPage = true;
    while (true) {
      const read = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        view: failed ? "activity" : "messages",
        limit: 100,
        runLimit: 50,
        // Keep the first and expected final activity pages whole. A result on a
        // middle page then needs an extra text read after the scan.
        maxCharsPerItem: failed && remainingItems > 100 ? 1 : 20_000,
        afterPosition,
      });
      run ??= read.recentRuns.find((candidate) => candidate.runId === runId);
      if (firstPage) {
        firstPage = false;
        backgroundTasks = read.thread.pendingBackgroundTasks ?? [];
        worktree =
          read.thread.worktreePath === null
            ? undefined
            : { path: read.thread.worktreePath, branch: read.thread.branch };
      }
      reply =
        read.items.findLast(
          (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
        ) ?? reply;
      if (failed) {
        error =
          read.items.findLast(
            (item) => item.type === "error" && (runId === null || item.runId === runId),
          ) ?? error;
      }
      if (!read.hasMore || read.nextPosition === null) break;
      if (!failed && probeSuccess && !tailProbed) {
        tailProbed = true;
        const tailPosition = Math.floor((read.thread.itemCount - 1) / 100) * 100 - 1;
        if (tailPosition > read.nextPosition) {
          const tail = yield* forwarding.readThread(scope, remote.environmentId, {
            threadId: remote.threadId,
            view: "messages",
            limit: 100,
            maxCharsPerItem: 20_000,
            afterPosition: tailPosition,
          });
          const tailReply = tail.items.findLast(
            (item) => item.type === "assistant_message" && (runId === null || item.runId === runId),
          );
          if (!tail.hasMore && tailReply !== undefined) {
            reply = tailReply;
            break;
          }
        }
      }
      afterPosition = read.nextPosition;
      remainingItems = read.thread.itemCount - afterPosition - 1;
    }
    reply = error ?? reply;
    const executedModel = run?.executedModel ?? undefined;
    if (reply === undefined) return { text: undefined, executedModel, worktree };
    let text = reply.text ?? "";
    let textOffset = reply.textTruncated ? (reply.nextTextOffset ?? null) : null;
    while (textOffset !== null) {
      const rest = yield* forwarding.readThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        itemId: reply.itemId,
        textOffset,
        maxCharsPerItem: 20_000,
      });
      const part = rest.items[0];
      if (part === undefined) break;
      text += part.text ?? "";
      textOffset = part.textTruncated ? (part.nextTextOffset ?? null) : null;
    }
    // A hold that ran out there leaves these running, as a local child's result names them.
    if (!failed) text = withDelegatedChildCommandsLeftRunning(text, backgroundTasks);
    return {
      text: run === undefined ? text : withExecutedModelNote(text, run.model, run.executedModel),
      executedModel,
      worktree,
    };
  });

  /**
   * Why following a task can never succeed, if that is what `error` means.
   * The far side's message already says what was refused and what to do; a
   * link forgotten here only reads as a bad request, so it is named.
   */
  const finalReason = Effect.fn("RemoteDelegation.finalReason")(
    function* (parentThreadId: ThreadId, taskId: NodeId, error: OrchestratorMcpFailure) {
      if (isFinal(error)) return error.message;
      if (error.code !== "invalid_request") return undefined;
      const { task } = yield* readTask(parentThreadId, taskId);
      const environmentId = task?.remoteChild?.environmentId;
      if (environmentId === undefined || environmentId === hereId) return error.message;
      const link = yield* links.get(environmentId);
      return Option.isSome(link) ? undefined : error.message;
    },
    Effect.orElseSucceed(() => undefined),
  );

  /** A task's thread there that ended without a reply. */
  const noReply = "(The thread in the linked environment ended without a reply.)";
  const noRun = (remote: OrchestrationV2RemoteTaskChild) =>
    isHere(remote)
      ? "The task's thread has no run to follow."
      : "The thread in the linked environment has no run to follow.";

  /**
   * Waits for the task's run there to end, completes the task here, and stops it there if it
   * ended here first. A revoked, expired or forgotten link, or a thread or run gone there,
   * fails the task with nothing left to stop; repeated defects here fail it too. Anything else
   * (the other machine asleep, a dropped route) is retried with back-off, and so is completing.
   */
  const follow = (parentThreadId: ThreadId, taskId: NodeId): Effect.Effect<void> =>
    Effect.suspend(() => {
      let defects = 0;
      const noDefect = Effect.sync(() => {
        defects = 0;
      });
      return followOnce(parentThreadId, taskId).pipe(
        Effect.tap(noDefect),
        // `false` means it is still running there: follow again straight away.
        Effect.repeat({ while: (done) => !done }),
        Effect.catchTags({
          OrchestratorMcpFailure: Effect.fn("RemoteDelegation.followFailed")(function* (error) {
            const reason = yield* finalReason(parentThreadId, taskId, error);
            if (reason === undefined) return yield* error;
            // Gone there, or no link to reach it by: nothing left to stop there.
            const { task } = yield* readTask(parentThreadId, taskId);
            const stopCount = task?.remoteChild?.stopCount;
            yield* complete(parentThreadId, taskId, "failed", reason, "stopped", stopCount);
          }),
        }),
        Effect.tapError(() => noDefect),
        Effect.tapDefect(() =>
          Effect.sync(() => {
            defects += 1;
          }),
        ),
        failOnDefect,
        Effect.retry({ schedule: followRetry, while: () => defects < FOLLOW_MAX_DEFECTS }),
        Effect.catch(
          Effect.fn("RemoteDelegation.followGaveUp")(
            function* () {
              const { task } = yield* readTask(parentThreadId, taskId);
              const remote = task?.remoteChild;
              // A task with its result keeps it; completing it again would owe another stop there.
              if (remote === undefined || task?.result !== null) return;
              const result = `Following the thread ${remote.threadId} in ${remote.label} failed repeatedly, so it may still run there (task_cancel stops it).`;
              yield* complete(parentThreadId, taskId, "failed", result, undefined);
            },
            failOnDefect,
            Effect.retry(followRetry),
          ),
        ),
        Effect.ignoreCause({ log: true }),
      );
    });

  /**
   * One wait on the task's thread there; true once the task here is done.
   * A task completed here first (cancelled, or its parent stopped) is
   * stopped there, and done once that stop is recorded here.
   */
  // The requests each followed task's parent was woken for: the wait's hint, not the record.
  const wokenRequests = new Map<NodeId, ReadonlySet<RuntimeRequestId>>();

  /** The task's wakes still queued on its parent, each with the request it is for. */
  const queuedWakes = Effect.fn("RemoteDelegation.queuedWakes")(function* (
    task: OrchestrationV2Subagent,
  ) {
    const { thread, runs } = yield* threads.getThreadRecords(task.threadId, ["runs"], {
      runStatuses: ["queued"],
    });
    const prefix = parentWakeMessageId(task.threadId, "" as RuntimeRequestId);
    const candidates = runs.filter(
      (run) => run.status === "queued" && run.userMessageId.startsWith(prefix),
    );
    const messages =
      candidates.length === 0
        ? new Map()
        : yield* threads.getMessagesById(
            task.threadId,
            candidates.map((run) => run.userMessageId),
          );
    const wakes = candidates.flatMap((run) => {
      const source = messages.get(run.userMessageId)?.notification?.source;
      return source?.kind === "delegated_task" && source.taskIds.includes(task.id)
        ? [{ run, requestId: run.userMessageId.slice(prefix.length) as RuntimeRequestId }]
        : [];
    });
    return { thread, wakes };
  });

  /**
   * Wakes the parent here for each request its task there waits on, as a task here would, and
   * cancels the task's queued wakes for any other. Those are read from the parent's queue, so a
   * wake queued before a restart is still cancelled once its request is answered there.
   */
  const tellParentOfRequests = Effect.fn("RemoteDelegation.tellParentOfRequests")(function* (
    task: OrchestrationV2Subagent,
    remote: OrchestrationV2RemoteTaskChild,
    pending: NonNullable<OrchestratorMcpThreadWaitResult["pendingRequests"]>,
  ) {
    const { thread, wakes } = yield* queuedWakes(task);
    const woken = wokenRequests.get(task.id) ?? new Set<RuntimeRequestId>();
    const live = new Set(pending.map((request) => request.requestId));
    if (thread.archivedAt === null && thread.deletedAt === null) {
      for (const request of pending) {
        if (woken.has(request.requestId)) continue;
        // Its command id is the request's, so one woken before a restart is not woken again.
        yield* threads
          .dispatch(
            parentWakeCommand(
              task,
              remote.threadId,
              {
                id: request.requestId,
                kind: request.kind,
                answeredByMessage: request.answeredByMessage,
                prompt: request.prompt,
                reason: request.reason,
              },
              remote.environmentId,
            ),
          )
          .pipe(Effect.ignoreCause({ log: true }));
      }
    }
    for (const { run, requestId } of wakes) {
      if (live.has(requestId)) continue;
      yield* threads
        .dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(
            `server:delegated-task-question-cancel:${task.threadId}:${requestId}`,
          ),
          threadId: task.threadId,
          runId: run.id,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    wokenRequests.set(task.id, live);
  });

  const followOnce = Effect.fn("RemoteDelegation.followOnce")(function* (
    parentThreadId: ThreadId,
    taskId: NodeId,
  ) {
    const sequence = yield* threads.getThreadEventSequence(parentThreadId);
    const { thread, task } = yield* readTask(parentThreadId, taskId);
    if (task?.remoteChild === undefined) return true;
    const remote = task.remoteChild;
    const scope =
      thread.deletedAt === null
        ? followScope(
            { threadId: parentThreadId, providerInstanceId: thread.providerInstanceId },
            remote,
          )
        : deletedParentScope(thread, remote);
    // Ended here, maybe while this follower backed off from an unreachable
    // machine or before a restart: it still has to be stopped there. So
    // does one its parent here was stopped after, for what followed there.
    if (task.result !== null) {
      if (
        remote.stoppedThere === false ||
        ((task.status === "cancelled" || task.status === "interrupted") &&
          remote.stoppedThere !== true)
      ) {
        const count = remote.stopCount === undefined ? "stop" : `stop-${remote.stopCount}`;
        // Named for its run too: a follow-up task shares the thread there and counts its own stops.
        const key = remote.runId === undefined ? count : `${count}:${remote.runId}`;
        yield* stopThere(scope, remote, key).pipe(
          // Its thread there now runs above what this side may touch, say
          // because the parent here was lowered since; no retry changes that.
          Effect.catchIf(isModeRefusal, (error) =>
            Effect.logWarning("A linked environment refused to stop a delegated task", {
              taskId,
              reason: error.message,
            }),
          ),
        );
        yield* complete(
          parentThreadId,
          taskId,
          terminalStatus(task.status),
          task.result,
          "stopped",
          remote.stopCount,
        );
        return yield* settled(parentThreadId, taskId);
      }
      return true;
    }
    const endedHere = threads
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: sequence,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.result !== null,
        ),
        Stream.runHead,
        Effect.flatMap((ended) =>
          Option.isSome(ended) ? Effect.succeed({ endedHere: true } as const) : Effect.never,
        ),
      );
    const waited = yield* (
      isHere(remote)
        ? waitHere(remote)
        : forwarding.waitForThread(scope, remote.environmentId, {
            threadId: remote.threadId,
            ...(remote.runId === undefined ? {} : { runId: remote.runId }),
            timeoutMs: FOLLOW_WAIT_MS,
            // A thread there whose run ended may still be waiting on its own
            // tasks to wake it for the answer, which a task here waits for too.
            // An older peer ignores this and reports the run alone.
            untilDelegatedWorkSettled: true,
            // Its questions and approvals end the wait too, so the parent here hears of them.
            untilPendingRequestsChangeFrom: [
              ...(wokenRequests.get(taskId) ??
                // After a restart, what its parent still has queued.
                (yield* queuedWakes(task)).wakes.map(({ requestId }) => requestId)),
            ],
          })
    ).pipe(Effect.raceFirst(endedHere));
    // The next look reads the result and stops it there.
    if ("endedHere" in waited) return false;
    const runGoesOn = waited.timedOut || waited.interruptedByIncomingMessage === true;
    // A run that ended there answers no request, so its wakes here are dropped.
    if (
      !isHere(remote) &&
      task.result === null &&
      (waited.pendingRequests !== undefined || !runGoesOn)
    ) {
      yield* tellParentOfRequests(task, remote, runGoesOn ? (waited.pendingRequests ?? []) : []);
    }
    if (runGoesOn) return false;
    // A task recorded without its run waits on the thread's latest; a
    // thread there with none has nothing left to wait for.
    if (waited.runId === null) {
      const reply = yield* lastReply(scope, remote, null);
      yield* complete(
        parentThreadId,
        taskId,
        reply.text === undefined ? "failed" : "completed",
        reply.text ?? noRun(remote),
        "ran-out",
        undefined,
        undefined,
        reply.worktree,
      );
      return yield* settled(parentThreadId, taskId);
    }
    if (!isTerminal(waited.status)) return false;
    // A later run's answer there may be another open follow-up's, or its restart, which no run id
    // here names; concurrent sends may record here out of their order there. Then this task's
    // answer is its own run's latest restart, the one waited on.
    const sharedThread =
      waited.resultRun !== undefined &&
      waited.resultRun.runId !== waited.runId &&
      (yield* threads.getThreadRecords(parentThreadId, ["subagents"]).pipe(
        Effect.map(({ subagents }) => {
          const recordedAt = subagents.find((task) => task.id === taskId)?.startedAt ?? null;
          return subagents.some(
            (other) =>
              other.id !== taskId &&
              other.remoteChild?.environmentId === remote.environmentId &&
              other.remoteChild.threadId === remote.threadId &&
              // One that settled before this was recorded ran before it there.
              (recordedAt === null ||
                other.completedAt === null ||
                DateTime.isGreaterThan(other.completedAt, recordedAt)),
          );
        }),
      ));
    const resultRun =
      waited.resultRun !== undefined && !sharedThread
        ? waited.resultRun
        : { runId: waited.runId, status: waited.status };
    const result = yield* lastReply(
      scope,
      remote,
      resultRun.runId,
      resultRun.status === "failed",
      resultRun.status === "completed",
    );
    yield* complete(
      parentThreadId,
      taskId,
      terminalStatus(resultRun.status),
      result.text ?? (isHere(remote) ? noRun(remote) : noReply),
      "ran-out",
      undefined,
      result.executedModel,
      result.worktree,
    );
    return yield* settled(parentThreadId, taskId);
  });

  /**
   * Whether the task is done here after the follower reported its run ran
   * out there. A cancel or Stop that landed while the reply was read keeps
   * its result, and still owes a stop there for what may follow the run;
   * the next look sends it.
   */
  const settled = (parentThreadId: ThreadId, taskId: NodeId) =>
    readTask(parentThreadId, taskId).pipe(
      Effect.map(({ task }) => task?.remoteChild?.stoppedThere === true),
    );

  const following = new Map<NodeId, { again: boolean }>();

  /**
   * `follow`, at most once per task. Asked again while it runs, say by a
   * Stop here on a task that already has its result, it looks once more
   * before it ends, so that stop is not missed.
   */
  const followOne = (parentThreadId: ThreadId, taskId: NodeId) =>
    Effect.suspend(() => {
      const running = following.get(taskId);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const state = { again: false };
      following.set(taskId, state);
      return follow(parentThreadId, taskId).pipe(
        // Checked and released in one step, so a request between them is never lost.
        Effect.repeat({
          while: () => {
            if (state.again) {
              state.again = false;
              return true;
            }
            following.delete(taskId);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (following.get(taskId) === state) {
              following.delete(taskId);
              wokenRequests.delete(taskId);
            }
          }),
        ),
      );
    });

  /**
   * Tells each thread there, one at a time, that its task's parent here is done, so it settles
   * as a subagent would. A parent active again is owed nothing; a thread gone there counts as
   * told. A failing link ends the pass: one attempt per retry however much it is owed.
   */
  const tellParentDonePass = Effect.fn("RemoteDelegation.tellParentDonePass")(function* (
    environmentId: EnvironmentId,
  ) {
    const owed = yield* projections.getRemoteTasksOwedParentDone({ environmentId });
    const told = new Set<string>();
    let refused = false;
    for (const { parentThreadId, taskId, threadId } of owed) {
      const key = `${parentThreadId}\0${threadId}`;
      if (!told.has(key)) {
        const stillOwed = (yield* projections.getRemoteTasksOwedParentDone({
          parentThreadId,
        })).some((row) => row.taskId === taskId);
        if (!stillOwed) {
          yield* Effect.logDebug("remote-delegation.parent-done-not-owed", {
            parentThreadId,
            threadId,
          });
          continue;
        }
        const answer =
          environmentId === hereId
            ? yield* tellParentDoneHere(threadId, parentThreadId)
            : yield* links.tellParentDone(environmentId, { threadId, parentThreadId });
        if (answer === "refused") {
          yield* Effect.logWarning("remote-delegation.parent-done-refused", {
            parentThreadId,
            environmentId,
            threadId,
          });
          refused = true;
          continue;
        }
        told.add(key);
      }
      yield* threads.dispatch({
        type: "delegated_task.remote.parent-done",
        commandId: CommandId.make(
          `command:remote-parent-done:${parentThreadId}:${taskId}:${yield* random.uuidV4()}`,
        ),
        threadId: parentThreadId,
        taskId,
      });
    }
    if (refused) {
      return yield* new Cause.UnknownError(
        undefined,
        "A linked environment refused a parent's end.",
      );
    }
    yield* Effect.logDebug("remote-delegation.parent-done-told", {
      environmentId,
      owed: owed.length,
      told: told.size,
    });
  });

  const tellingParentDone = new Map<EnvironmentId, { again: boolean }>();

  /**
   * `tellParentDonePass` until it gets there, with at most one pass per environment, retried
   * with back-off. Work owed meanwhile runs one more pass; nothing is recorded until the thread
   * there has it.
   */
  const tellParentDone = (environmentId: EnvironmentId) =>
    Effect.suspend(() => {
      const running = tellingParentDone.get(environmentId);
      if (running !== undefined) {
        running.again = true;
        return Effect.void;
      }
      const state = { again: false };
      tellingParentDone.set(environmentId, state);
      return tellParentDonePass(environmentId).pipe(
        failOnDefect,
        Effect.retry(followRetry),
        Effect.ignoreCause({ log: true }),
        Effect.repeat({
          while: () => {
            if (state.again) {
              state.again = false;
              return true;
            }
            tellingParentDone.delete(environmentId);
            return false;
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (tellingParentDone.get(environmentId) === state) {
              tellingParentDone.delete(environmentId);
            }
          }),
        ),
      );
    });

  /** Tells each environment the tasks of `parentThreadId` (or of every done parent) owe it. */
  const tellOwedParentDone = (parentThreadId?: ThreadId) =>
    projections
      .getRemoteTasksOwedParentDone(parentThreadId === undefined ? undefined : { parentThreadId })
      .pipe(
        Effect.flatMap((owed) =>
          Effect.forEach(
            new Set(owed.map((row) => row.environmentId)),
            (environmentId) => tellParentDone(environmentId).pipe(Effect.forkIn(followers)),
            { discard: true },
          ),
        ),
        Effect.ignoreCause({ log: true }),
      );

  const cancel: RemoteDelegation["Service"]["cancel"] = Effect.fn("RemoteDelegation.cancel")(
    function* (scope, task, input) {
      const remote = task.remoteChild;
      if (remote === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "task_not_found",
          message: `Delegated task ${task.id} is not remote.`,
        });
      }
      const { reason } = input;
      const there = followScope(scope.thread, remote);
      // A later cancel stops what started there since; a retry of this one, nothing new.
      const key = `cancel:${encodeURIComponent(scope.requestNamespace)}:${
        input.clientRequestId ?? (yield* random.uuidV4())
      }`;
      // An agent's cancel stops a thread here only up to its own thread's modes, as there.
      const parentModes = isHere(remote)
        ? yield* threads.getThreadShell(task.threadId).pipe(Effect.mapError(localFailure))
        : null;
      const stopTask =
        parentModes === null
          ? stopThere(there, remote, key, reason, true)
          : stopThere(there, remote, key, reason, true).pipe(
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: parentModes.runtimeMode,
                interactionMode: parentModes.interactionMode,
              }),
            );
      if (task.result !== null) {
        // Best effort: the result stands whether or not the stop gets there.
        yield* stopTask.pipe(
          Effect.andThen(
            complete(
              task.threadId,
              task.id,
              terminalStatus(task.status),
              task.result,
              "stopped",
              remote.stopCount,
            ),
          ),
          Effect.ignoreCause({ log: true }),
        );
        return {
          taskId: task.id,
          status:
            task.status === "completed" || task.status === "failed" || task.status === "interrupted"
              ? task.status
              : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      // A link that is gone or a machine that is down still cancels the task
      // here; its follower keeps trying to stop it there, across restarts.
      const unstopped = yield* stopTask.pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
      const cancelled = reason === undefined ? "Cancelled." : `Cancelled: ${reason}`;
      yield* complete(
        task.threadId,
        task.id,
        "cancelled",
        unstopped === undefined
          ? cancelled
          : `${cancelled} It could not be stopped in ${remote.label} and may still run there: ${unstopped}`,
        unstopped === undefined ? "stopped" : undefined,
        remote.stopCount,
      ).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.cancel-record-failed", { taskId: task.id, cause }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the cancellation.",
            }),
        ),
      );
      return {
        taskId: task.id,
        status: "cancel_requested",
      } satisfies OrchestratorMcpTaskCancelResult;
    },
  );

  const readThere = Effect.fn("RemoteDelegation.readThere")(
    function* (scope: ThreadScope, task: OrchestrationV2Subagent) {
      const remote = task.remoteChild;
      if (remote === undefined) return null;
      if (isHere(remote)) {
        if (remote.runId === undefined) return null;
        const { runs } = yield* threads.getThreadRecords(remote.threadId, ["runs"]);
        const run = runs.find((candidate) => candidate.id === remote.runId);
        return { status: run === undefined ? null : runOutcome(run), worktree: null };
      }
      const read = yield* forwarding.readThread(
        followScope(scope.thread, remote),
        remote.environmentId,
        { threadId: remote.threadId, limit: 1, runLimit: 50 },
      );
      return {
        status:
          remote.runId === undefined
            ? null
            : (read.recentRuns.find((run) => run.runId === remote.runId)?.status ?? null),
        worktree:
          read.thread.worktreePath === null
            ? null
            : { path: read.thread.worktreePath, branch: read.thread.branch },
      };
    },
    Effect.orElseSucceed(() => null),
  );

  const start: RemoteDelegation["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // A finished task's follower has ended, so a Stop here that owes its
        // thread there a stop starts it again. Started before the scan below;
        // a Stop that slips between the two stays owed for the next start.
        yield* Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "subagent.updated" && event.payload.remoteChild?.stoppedThere === false
            ? followOne(event.threadId, event.payload.id).pipe(Effect.forkIn(followers))
            : event.type === "thread.settled" ||
                event.type === "thread.archived" ||
                event.type === "thread.deleted"
              ? tellOwedParentDone(event.threadId).pipe(Effect.forkIn(followers))
              : Effect.void,
        ).pipe(
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(followers, { startImmediately: true }),
        );
        yield* tellOwedParentDone().pipe(Effect.forkIn(followers));
        const open = yield* projections.getOpenRemoteDelegatedTasks;
        yield* Effect.forEach(
          open,
          ({ parentThreadId, taskId }) => followOne(parentThreadId, taskId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        );
      }).pipe(Effect.ignoreCause({ log: true })),
    );

  return RemoteDelegation.of({ delegate, adoptLocal, followUp, cancel, readThere, start });
});

/** A defect, logged, as a failure, so a retry covers it. */
const failOnDefect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchDefect(effect, (defect) =>
    Effect.logWarning("A remote task's follower hit a defect", Cause.die(defect)).pipe(
      Effect.andThen(Effect.fail(new Cause.UnknownError(defect, "A follower hit a defect."))),
    ),
  );

const isTerminal = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted" ||
  status === "rolled_back";

const terminalStatus = (status: string): "completed" | "failed" | "cancelled" | "interrupted" =>
  status === "completed" || status === "failed" || status === "interrupted" ? status : "cancelled";

export const layer = Layer.effect(RemoteDelegation, make);
