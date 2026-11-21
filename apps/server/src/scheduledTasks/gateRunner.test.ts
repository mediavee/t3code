import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, vi } from "vite-plus/test";

import * as GateRunner from "./gateRunner.ts";

afterEach(() => vi.unstubAllEnvs());

const withRunner = <A, E>(
  program: (
    runner: GateRunner.ScheduledTaskGateRunner["Service"],
    dir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const runner = yield* GateRunner.make(yield* ChildProcessSpawner.ChildProcessSpawner);
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    return yield* program(runner, dir);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "runs the command in its folder without T3's own variables",
  () =>
    withRunner((runner, dir) =>
      Effect.gen(function* () {
        vi.stubEnv("T3CODE_GATE_PROBE", "internal");
        vi.stubEnv("GATE_PROBE", "kept");
        const ran = yield* runner.run({
          command: 'echo "${T3CODE_GATE_PROBE-unset} $GATE_PROBE"; pwd; echo oops >&2; exit 3',
          cwd: dir,
          timeoutMs: 10_000,
        });
        const realDir = yield* (yield* FileSystem.FileSystem).realPath(dir);
        expect(ran).toEqual({
          _tag: "Exited",
          code: 3,
          stdout: `unset kept\n${realDir}\n`,
          stderr: "oops\n",
        });
      }),
    ),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "a timeout kills the command's whole process group",
  () =>
    withRunner((runner, dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const ran = yield* runner.run({
          // The background sleep would outlive a kill aimed at the shell alone.
          command: "echo $$ > leader; sleep 30 & echo started; sleep 30",
          cwd: dir,
          timeoutMs: 1_000,
        });
        expect(ran).toEqual({ _tag: "TimedOut" });
        const leader = Number((yield* fs.readFileString(`${dir}/leader`)).trim());
        expect(leader).toBeGreaterThan(1);
        // EPERM: only zombies are left, which macOS reports for a group no member can receive.
        expect(() => process.kill(-leader, 0)).toThrow(/ESRCH|EPERM/);
      }),
    ),
);
