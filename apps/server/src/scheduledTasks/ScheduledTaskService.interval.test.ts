import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { type ScheduledTask, ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, vi } from "vite-plus/test";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

afterEach(() => vi.unstubAllEnvs());

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Scheduler.layer,
  ManagedPolicy.layerTest(),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
    launch: () => Effect.die("synthetic dispatch failure"),
    isNonGitProject: () => Effect.succeed(false),
  }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
);
const serviceLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = {
  commandId: "interval-duration",
  title: "Interval review",
  prompt: "Review the open pull requests.",
  enabled: true,
  projectId: "project-interval-duration",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

it.effect.each([
  {
    zone: "America/New_York",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T05:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-11-01T07:30:00.000Z",
  },
  {
    zone: "America/New_York",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "UTC",
    from: "2026-11-01T06:30:00.000Z",
    everyMs: 60_000,
    expected: "2026-11-01T06:31:00.000Z",
  },
  {
    zone: "Asia/Tokyo",
    from: "2026-03-08T06:30:00.000Z",
    everyMs: 7_200_000,
    expected: "2026-03-08T08:30:00.000Z",
  },
] as const)("persists elapsed interval $zone from $from", ({ zone, from, everyMs, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", zone);
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({ ...input, schedule: { type: "interval", everyMs } });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);

      const paused = yield* service.setEnabled({ id: created.task.id, enabled: false });
      expect(paused.task.nextRunAt).toBeNull();
      const resumed = yield* service.setEnabled({ id: created.task.id, enabled: true });
      expect(resumed.task.nextRunAt).toBe(expected);

      // Exercise completion rescheduling without starting any provider process.
      const completed = yield* service.runNow({ id: created.task.id });
      expect(completed.task.lastRunStatus).toBe("failed");
      expect(completed.threadId).toBeNull();
      expect(completed.task.runCount).toBe(1);
      expect(completed.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    // Keep the real scheduler parked while exercising finite service actions.
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect.each([
  { from: "2026-03-07T23:30:00.000Z", expected: "2026-03-08T13:00:00.000Z" },
  { from: "2026-10-31T23:30:00.000Z", expected: "2026-11-01T14:00:00.000Z" },
] as const)("keeps fixed-time schedules on the local calendar from $from", ({ from, expected }) =>
  Effect.gen(function* () {
    vi.stubEnv("TZ", "America/New_York");
    yield* TestClock.setTime(Date.parse(from));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({
        ...input,
        schedule: { type: "fixed_time", timeOfDay: "09:00" },
      });
      const created = yield* service.upsert(decoded);
      expect(created.task.nextRunAt).toBe(expected);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe(expected);
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

// Each launch takes two minutes, so a manual run can start before the run time and end after it.
const slowLaunchLayer = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.merge(
      dependencies,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: () => TestClock.adjust("2 minutes").pipe(Effect.andThen(Effect.die("synthetic"))),
      }),
    ),
  ),
);

it.effect("runs a one-time schedule once and rejects past times", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:59:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const decoded = yield* decodeInput({
        ...input,
        schedule: { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
      });
      const created = yield* service.upsert(decoded);
      expect(created.task.schedule).toEqual({ type: "once", runAt: "2026-11-01T08:00:00.000Z" });
      expect(created.task.nextRunAt).toBe("2026-11-01T08:00:00.000Z");

      // A manual run that starts before the time keeps the scheduled run, even if it ends after.
      const early = yield* service.runNow({ id: created.task.id });
      expect(early.task.nextRunAt).toBe("2026-11-01T08:00:00.000Z");

      const due = yield* service.runNow({ id: created.task.id });
      expect(due.task.nextRunAt).toBeNull();
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBeNull();

      yield* service.setEnabled({ id: created.task.id, enabled: false });
      const resumed = yield* service
        .setEnabled({ id: created.task.id, enabled: true })
        .pipe(Effect.flip);
      expect(resumed.message).toBe("The run time has passed. Pick a time in the future.");

      const past = yield* service
        .upsert({ ...decoded, commandId: undefined, title: "Late" })
        .pipe(Effect.flip);
      expect(past.message).toBe("The run time has passed. Pick a time in the future.");
    }).pipe(Effect.provide(slowLaunchLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

const ONCE = { type: "once", runAt: "2026-11-01T08:00:00Z" } as const;
/** A next run that only the simulated concurrent write produces. */
const MOVED = "2030-01-01T00:00:00.000Z";

const onceInput = {
  ...input,
  commandId: "once-race",
  schedule: { type: "once", runAt: "2026-11-01T08:00:00Z" },
};

it.effect.each([
  { change: "a run completes", saved: ONCE, edited: ONCE, pause: false, expected: MOVED },
  {
    change: "a run completes during a padded-time edit",
    saved: { type: "fixed_time", timeOfDay: "9:00" },
    edited: { type: "fixed_time", timeOfDay: "09:00" },
    pause: false,
    expected: MOVED,
  },
  {
    change: "another client pauses the task",
    saved: ONCE,
    edited: ONCE,
    pause: true,
    expected: "2026-11-01T08:00:00.000Z",
  },
] as const)(
  "a title save keeps the stored next run only while nothing else changed: $change",
  ({ saved, edited, pause, expected }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
      // The project check runs between the save's read and write, so it stands in for
      // a concurrent write in that gap.
      const writeMidSave = Layer.unwrap(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () =>
              sql`UPDATE scheduled_tasks SET next_run_at = ${MOVED}, enabled = ${pause ? 0 : 1}`.pipe(
                Effect.as(false),
                Effect.orDie,
              ),
          });
        }),
      );
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(Layer.merge(dependencies, writeMidSave)),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const worktree = { type: "worktree", baseRef: "main" };
        yield* service.upsert(
          yield* decodeInput({
            ...onceInput,
            schedule: saved,
            workspaceStrategy: { type: "root" },
          }),
        );
        const renamed = yield* service.upsert(
          yield* decodeInput({
            ...onceInput,
            schedule: edited,
            workspaceStrategy: worktree,
            title: "Renamed",
          }),
        );
        expect(renamed.task.enabled).toBe(true);
        expect(renamed.task.nextRunAt).toBe(expected);
      }).pipe(Effect.provide(layer));
    }).pipe(
      Effect.provideService(ServerActivation, Effect.never),
      Effect.provide(SqlitePersistence.layerMemory),
    ),
);

it.effect("keeps a one-time run after a restart interrupts an earlier manual run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:59:00.000Z"));
    const sql = yield* SqlClient.SqlClient;
    const created = yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* service.upsert(yield* decodeInput(onceInput));
    }).pipe(Effect.provide(serviceLayer));
    yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = '2026-11-01T07:59:00.000Z'`;

    yield* TestClock.setTime(Date.parse("2026-11-01T08:05:00.000Z"));
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const [task] = (yield* service.list()).tasks;
      expect(task?.id).toBe(created.task.id);
      expect(task?.lastRunStatus).toBe("failed");
      expect(task?.nextRunAt).toBe("2026-11-01T08:00:00.000Z");
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("reports the stored task when the row was replaced during the run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    // The launch stands in for a delete and same-id recreate while the run is out.
    const replaceRowDuringLaunch = Layer.unwrap(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            sql`UPDATE scheduled_tasks SET last_run_status = 'never', last_run_at = NULL, run_count = 0`.pipe(
              Effect.orDie,
              Effect.andThen(Effect.die("synthetic dispatch failure")),
            ),
        });
      }),
    );
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(Layer.merge(dependencies, replaceRowDuringLaunch)),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const created = yield* service.upsert(yield* decodeInput(onceInput));
      const ran = yield* service.runNow({ id: created.task.id });
      expect(ran.task.runCount).toBe(0);
      expect(ran.task.lastRunStatus).toBe("never");
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("an interval run waits while its last new-thread run is active, across a restart", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-11-01T07:00:00.000Z"));
    const launched = yield* Queue.unbounded<ThreadId>();
    const launches = yield* Ref.make(0);
    const busyThreads = yield* Ref.make<ReadonlySet<string>>(new Set());
    const runningLayer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          dependencies,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.updateAndGet(launches, (n) => n + 1).pipe(
                Effect.map((n) => ThreadId.make(`thread:run-${n}`)),
                Effect.tap((threadId) =>
                  Ref.update(busyThreads, (all) => new Set(all).add(threadId)),
                ),
                Effect.tap((threadId) => Queue.offer(launched, threadId)),
                Effect.map((threadId) => ({ threadId, resumed: false }) as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            // The run outcome follower stops at an unknown thread.
            getThreadShell: () => Effect.succeed(null),
            getThreadRecords: (threadId, _fields, options) =>
              Ref.get(busyThreads).pipe(
                Effect.map(
                  (busy) =>
                    ({
                      runs:
                        busy.has(threadId) && options?.runStatuses?.includes("running")
                          ? [{ id: "run:active", status: "running" }]
                          : [],
                    }) as never,
                ),
              ),
          }),
        ),
      ),
    );
    const withService = <A, E>(
      program: (
        service: ScheduledTaskService.ScheduledTaskService["Service"],
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Layer.build(runningLayer).pipe(
          Effect.flatMap((context) =>
            program(Context.get(context, ScheduledTaskService.ScheduledTaskService)),
          ),
        ),
      );
    const until = (
      service: ScheduledTaskService.ScheduledTaskService["Service"],
      predicate: (task: ScheduledTask | undefined) => boolean,
    ) =>
      service.subscribeList().pipe(
        Stream.filter(({ tasks }) => predicate(tasks[0])),
        Stream.runHead,
      );

    const firstNextRunAt = yield* withService((service) =>
      Effect.gen(function* () {
        const decoded = yield* decodeInput({
          ...input,
          commandId: "no-overlap",
          schedule: { type: "interval", everyMs: 60_000 },
        });
        yield* service.upsert(decoded);
        yield* TestClock.adjust("65 seconds");
        expect(yield* Queue.take(launched)).toBe("thread:run-1");
        yield* until(service, (task) => task?.runCount === 1);
        return (yield* service.list()).tasks[0]?.nextRunAt;
      }),
    );

    // A restart forgets in-memory state; the stored thread still holds the next tick.
    yield* withService((service) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("65 seconds");
        // Settled either way: skipped, or dispatched and recorded.
        yield* until(
          service,
          (task) => task?.nextRunAt !== firstNextRunAt && task?.lastRunStatus !== "running",
        );
        const [skipped] = (yield* service.list()).tasks;
        expect(skipped?.lastRunError).toMatch(/^Skipped: the previous run is still active/);
        expect(skipped?.lastRunStatus).toBe("failed");
        expect(skipped?.runCount).toBe(1);
        expect(yield* Ref.get(launches)).toBe(1);

        yield* Ref.set(busyThreads, new Set());
        yield* TestClock.adjust("65 seconds");
        expect(yield* Queue.take(launched)).toBe("thread:run-2");
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
