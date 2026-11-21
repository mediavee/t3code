import {
  type EnvironmentId,
  fleetWorkState,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { parseThreadKey, threadKey } from "./entities.ts";

/** What a thread's strip shows about the children it started. */
export interface ThreadFleetRollup {
  /** Working, or waiting on their own children. */
  readonly running: number;
  /** Waiting for an answer or an approval. */
  readonly blocked: number;
  readonly failed: number;
  readonly done: number;
  readonly openPullRequests: number;
  /** The child that has waited longest for an answer. */
  readonly firstBlocked: ScopedThreadRef | null;
}

export interface ThreadFleetChild {
  readonly environmentId: EnvironmentId;
  readonly thread: OrchestrationV2ThreadShell;
}

const needsAnswer = (thread: OrchestrationV2ThreadShell) => {
  const kind = thread.pendingRuntimeRequest?.kind;
  return kind !== undefined && kind !== "auth_refresh" && kind !== "dynamic_tool_call";
};

/** A subagent of `parent`, or a task it delegated here or from another environment. */
export function isFleetChildOf(
  parent: ScopedThreadRef,
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): boolean {
  if (thread.archivedAt !== null || thread.lineage.sideChat === true) return false;
  if (thread.lineage.relationshipToParent === "subagent") {
    return (
      environmentId === parent.environmentId && thread.lineage.parentThreadId === parent.threadId
    );
  }
  const from = thread.delegatedFrom;
  return (
    from !== undefined &&
    from.environmentId === parent.environmentId &&
    from.threadId === parent.threadId
  );
}

/** Null without children, so a thread that started none shows no strip. */
export function rollUpThreadFleet(
  children: ReadonlyArray<ThreadFleetChild>,
): ThreadFleetRollup | null {
  if (children.length === 0) return null;
  let running = 0;
  let blocked = 0;
  let failed = 0;
  let done = 0;
  let firstBlocked: { ref: ScopedThreadRef; at: number } | null = null;
  const openPullRequests = new Set<string>();
  for (const { environmentId, thread } of children) {
    const asking = needsAnswer(thread);
    const state = fleetWorkState(
      thread,
      asking,
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
    );
    if (state === "needs_answer") {
      blocked += 1;
      const at = DateTime.toEpochMillis(thread.pendingRuntimeRequest!.createdAt);
      if (firstBlocked === null || at < firstBlocked.at) {
        firstBlocked = { ref: { environmentId, threadId: thread.id }, at };
      }
    } else if (state === "working" || state === "waiting_for_children") running += 1;
    else if (state === "failed") failed += 1;
    else done += 1;
    for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
      const pullRequestState = link.snapshot?.state;
      if (pullRequestState !== "merged" && pullRequestState !== "closed") {
        openPullRequests.add(link.url);
      }
    }
  }
  return {
    running,
    blocked,
    failed,
    done,
    openPullRequests: openPullRequests.size,
    firstBlocked: firstBlocked?.ref ?? null,
  };
}

const sameRollup = (left: ThreadFleetRollup | null, right: ThreadFleetRollup | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.running === right.running &&
    left.blocked === right.blocked &&
    left.failed === right.failed &&
    left.done === right.done &&
    left.openPullRequests === right.openPullRequests &&
    (left.firstBlocked === null
      ? right.firstBlocked === null
      : right.firstBlocked !== null &&
        threadKey(left.firstBlocked) === threadKey(right.firstBlocked)));

/**
 * A thread's fleet roll-up from the shells the client already holds. Streaming ticks keep the
 * previous value, so the strip renders only when a count changes.
 */
export function createThreadFleetAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly environmentThreadsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
}) {
  const family = Atom.family((key: string) => {
    const parent = parseThreadKey(key);
    let previous: ThreadFleetRollup | null = null;
    return Atom.make((get) => {
      const children: ThreadFleetChild[] = [];
      for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
        for (const thread of get(input.environmentThreadsAtom(environmentId))) {
          if (isFleetChildOf(parent, environmentId, thread))
            children.push({ environmentId, thread });
        }
      }
      const next = rollUpThreadFleet(children);
      if (sameRollup(previous, next)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`thread-fleet:${key}`));
  });
  const empty = Atom.make<ThreadFleetRollup | null>(null);
  return (ref: ScopedThreadRef | null) => (ref === null ? empty : family(threadKey(ref)));
}
