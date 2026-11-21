import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { isListedThreadLineage } from "@t3tools/contracts";

import { scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { resolveThreadActivityTimestamp, toSortableTimestamp } from "./threadSort.ts";

/**
 * Tasks delegated here by one parent thread the client cannot list. Lists show
 * one row for the parent in the place of `representativeKey`, its most relevant task.
 * Keys are `scopedThreadKey`s, as list rows use.
 */
export interface DelegatedTaskGroup {
  /** The parent's thread key. */
  readonly key: string;
  readonly parent: ScopedThreadRef;
  readonly title: string;
  /** The parent machine's label in the client's environment catalog, if it has one. */
  readonly environmentLabel: string | null;
  /** The most recently active unsettled task, or the most recently active one when all are settled. */
  readonly representativeKey: string;
  /** Most recently active first. */
  readonly taskKeys: ReadonlyArray<string>;
}

export interface DelegatedTaskGroups {
  readonly groups: ReadonlyArray<DelegatedTaskGroup>;
  readonly byRepresentativeKey: ReadonlyMap<string, DelegatedTaskGroup>;
  /** Grouped tasks other than representatives: they have no row of their own. */
  readonly foldedKeys: ReadonlySet<string>;
}

export const NO_DELEGATED_TASK_GROUPS: DelegatedTaskGroups = {
  groups: [],
  byRepresentativeKey: new Map(),
  foldedKeys: new Set(),
};

type GroupableThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "archivedAt"
  | "lineage"
  | "delegatedFrom"
  | "settledOverride"
  | "latestUserMessageAt"
  | "latestRun"
  | "updatedAt"
>;

/**
 * Groups the delegated tasks among `threads`, the threads lists show, by parent. Those
 * lists leave out tasks under a parent they show; a parent known to be archived leaves
 * its tasks listed on their own.
 */
export function groupDelegatedTasks(input: {
  readonly threads: ReadonlyArray<GroupableThread>;
  readonly isParentArchived: (parent: ScopedThreadRef) => boolean;
  readonly environmentLabel: (environmentId: EnvironmentId) => string | null;
}): DelegatedTaskGroups {
  const byParent = new Map<string, Array<{ key: string; thread: GroupableThread; at: number }>>();
  for (const thread of input.threads) {
    const from = thread.delegatedFrom;
    if (from == null || thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) {
      continue;
    }
    const key = scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id });
    const parentKey = scopedThreadKey(from);
    let tasks = byParent.get(parentKey);
    if (tasks === undefined) {
      const parent = { environmentId: from.environmentId, threadId: from.threadId };
      if (input.isParentArchived(parent)) continue;
      tasks = [];
      byParent.set(parentKey, tasks);
    }
    const at = toSortableTimestamp(resolveThreadActivityTimestamp(thread) ?? undefined) ?? 0;
    tasks.push({ key, thread, at });
  }
  if (byParent.size === 0) return NO_DELEGATED_TASK_GROUPS;
  const groups: DelegatedTaskGroup[] = [];
  const byRepresentativeKey = new Map<string, DelegatedTaskGroup>();
  const foldedKeys = new Set<string>();
  for (const [key, tasks] of byParent) {
    tasks.sort((left, right) => right.at - left.at || (left.key < right.key ? -1 : 1));
    const newest = tasks[0]!;
    const representative =
      tasks.find((task) => task.thread.settledOverride !== "settled") ?? newest;
    const from = newest.thread.delegatedFrom!;
    const group: DelegatedTaskGroup = {
      key,
      parent: { environmentId: from.environmentId, threadId: from.threadId },
      title: from.title,
      environmentLabel: input.environmentLabel(from.environmentId),
      representativeKey: representative.key,
      taskKeys: tasks.map((task) => task.key),
    };
    groups.push(group);
    byRepresentativeKey.set(representative.key, group);
    for (const task of tasks) if (task !== representative) foldedKeys.add(task.key);
  }
  return { groups, byRepresentativeKey, foldedKeys };
}

const sameGroup = (left: DelegatedTaskGroup, right: DelegatedTaskGroup) =>
  left.key === right.key &&
  left.title === right.title &&
  left.environmentLabel === right.environmentLabel &&
  left.representativeKey === right.representativeKey &&
  left.taskKeys.length === right.taskKeys.length &&
  left.taskKeys.every((taskKey, index) => taskKey === right.taskKeys[index]);

export function delegatedTaskGroupsEqual(
  left: DelegatedTaskGroups,
  right: DelegatedTaskGroups,
): boolean {
  return (
    left.groups.length === right.groups.length &&
    left.groups.every((group, index) => sameGroup(group, right.groups[index]!))
  );
}
