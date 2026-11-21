import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { createThreadFleetAtom, isFleetChildOf, rollUpThreadFleet } from "./threadFleet.ts";

const here = EnvironmentId.make("environment-here");
const there = EnvironmentId.make("environment-there");
const parent = { environmentId: here, threadId: ThreadId.make("thread-parent") };

const subagent = (
  id: string,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  lineage: {
    rootThreadId: parent.threadId,
    parentThreadId: parent.threadId,
    relationshipToParent: "subagent",
  },
  ...fields,
});

const delegated = (
  id: string,
  fields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...v2ThreadShell,
  id: ThreadId.make(id),
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  delegatedFrom: { ...parent, title: "Parent" },
  ...fields,
});

const asking = (kind: "user_input" | "command", at: string) => ({
  pendingRuntimeRequest: {
    id: RuntimeRequestId.make(`request-${at}`),
    kind,
    createdAt: DateTime.makeUnsafe(at),
  },
});

const pullRequest = (number: number, state: "open" | "merged" | null) => ({
  host: "github.com",
  repository: "acme/app",
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  source: "agent" as const,
  linkedAt: "2026-06-20T00:00:00.000Z",
  stack: null,
  snapshot:
    state === null
      ? null
      : {
          state,
          title: "PR",
          isDraft: false,
          headBranch: "branch",
          baseBranch: "main",
          updatedAt: null,
          syncedAt: "2026-06-20T00:00:00.000Z",
        },
});

describe("rollUpThreadFleet", () => {
  it("counts each child once and opens the one that has waited longest", () => {
    const rollup = rollUpThreadFleet([
      { environmentId: here, thread: subagent("running", { status: "running" }) },
      // Its turn ended but a command it waits on still runs.
      {
        environmentId: here,
        thread: subagent("waiting-on-work", {
          status: "completed",
          pendingBackgroundTasks: [{ taskId: "build", kind: "command", awaited: true }],
        }),
      },
      {
        environmentId: there,
        thread: delegated("newer-question", {
          status: "running",
          ...asking("user_input", "2026-06-20T00:05:00.000Z"),
        }),
      },
      {
        environmentId: here,
        thread: delegated("older-approval", {
          status: "running",
          ...asking("command", "2026-06-20T00:01:00.000Z"),
        }),
      },
      // A token refresh is not a question for anyone.
      {
        environmentId: here,
        thread: subagent("refreshing", {
          status: "completed",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-auth"),
            kind: "auth_refresh",
            createdAt: v2Now,
          },
        }),
      },
      // A secret card only the user can fill.
      {
        environmentId: here,
        thread: subagent("secret", {
          status: "running",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-secret"),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe("2026-06-20T00:09:00.000Z"),
            userOnly: true,
          },
        }),
      },
      { environmentId: here, thread: subagent("failed", { status: "failed" }) },
      { environmentId: here, thread: subagent("interrupted", { status: "interrupted" }) },
      {
        environmentId: here,
        thread: subagent("done", {
          status: "completed",
          pullRequests: [pullRequest(1, "merged"), pullRequest(2, "open")],
        }),
      },
      // The same pull request linked on two children is one open pull request.
      {
        environmentId: there,
        thread: delegated("same-pr", { status: "cancelled", pullRequests: [pullRequest(2, null)] }),
      },
    ]);
    expect(rollup).toEqual({
      running: 2,
      blocked: 3,
      failed: 2,
      done: 3,
      openPullRequests: 1,
      firstBlocked: { environmentId: here, threadId: ThreadId.make("older-approval") },
    });
  });

  it("is null for a thread that started no children", () => {
    expect(rollUpThreadFleet([])).toBeNull();
  });
});

describe("isFleetChildOf", () => {
  it.each([
    ["its subagent", here, subagent("child"), true],
    ["a task it delegated to another environment", there, delegated("child"), true],
    ["a subagent of the same id in another environment", there, subagent("child"), false],
    [
      "another thread's subagent",
      here,
      subagent("child", {
        lineage: {
          rootThreadId: parent.threadId,
          parentThreadId: ThreadId.make("thread-other"),
          relationshipToParent: "subagent",
        },
      }),
      false,
    ],
    [
      "its side chat",
      here,
      subagent("child", {
        lineage: {
          rootThreadId: parent.threadId,
          parentThreadId: parent.threadId,
          relationshipToParent: "subagent",
          sideChat: true,
        },
      }),
      false,
    ],
    ["an archived task", there, delegated("child", { archivedAt: v2Now }), false],
    [
      "its provider-native subagent, whose shell never runs",
      here,
      subagent("child", { creationSource: "provider" }),
      false,
    ],
  ] as const)("%s: %s", (_, environmentId, thread, expected) => {
    expect(isFleetChildOf(parent, environmentId, thread)).toBe(expected);
  });
});

describe("createThreadFleetAtom", () => {
  it("keeps its value while a child only streams", () => {
    const threadsAtom = Atom.family((_environmentId: EnvironmentId) =>
      Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]),
    );
    const fleetAtom = createThreadFleetAtom({
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map(
          [here, there].map((environmentId) => [
            environmentId,
            {
              target: new PrimaryConnectionTarget({
                environmentId,
                label: "Environment",
                httpBaseUrl: "https://example.test",
                wsBaseUrl: "wss://example.test",
              }),
              profile: Option.none(),
              enabled: true,
            },
          ]),
        ),
      }),
      environmentThreadsAtom: threadsAtom,
    })(parent);
    const registry = AtomRegistry.make();
    const dispose = registry.mount(fleetAtom);
    const child = subagent("child", { status: "running" });
    registry.set(threadsAtom(here), [child]);
    const before = registry.get(fleetAtom);
    expect(before).toMatchObject({ running: 1 });

    registry.set(threadsAtom(here), [
      { ...child, updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"), itemCount: 9 },
    ]);
    expect(registry.get(fleetAtom)).toBe(before);

    registry.set(threadsAtom(there), [delegated("task", { status: "failed" })]);
    expect(registry.get(fleetAtom)).toMatchObject({ running: 1, failed: 1 });
    dispose();
    registry.dispose();
  });
});
