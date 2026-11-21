import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";

/** Collected per stream; the prompt keeps far less, but the hash and stderr tail see this much. */
const GATE_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface GateRunInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export type GateRun =
  | {
      readonly _tag: "Exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "SpawnFailed"; readonly message: string };

/** Runs a scheduled task's gate command; interrupting the run kills its process group. */
export class ScheduledTaskGateRunner extends Context.Service<
  ScheduledTaskGateRunner,
  { readonly run: (input: GateRunInput) => Effect.Effect<GateRun> }
>()("t3/scheduledTasks/gateRunner/ScheduledTaskGateRunner") {}

// T3's own variables (ports, tokens, home) stay out of a command the owner wrote.
const isInternalEnvKey = (key: string) => {
  const upper = key.toUpperCase();
  return (
    upper.startsWith("T3CODE_") ||
    upper.startsWith("VITE_") ||
    upper === "ELECTRON_RUN_AS_NODE" ||
    upper === "ELECTRON_RENDERER_PORT"
  );
};

/** Undefined values remove the key from the inherited environment. */
const gateEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.keys(env)
      .filter(isInternalEnvKey)
      .map((key) => [key, undefined]),
  );

const shellCommand = (command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? { command: env.ComSpec ?? "cmd.exe", args: ["/d", "/c", command] }
    : { command: "/bin/sh", args: ["-c", command] };

export const make = Effect.fn("ScheduledTaskGateRunner.make")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.make().pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  const run = Effect.fn("ScheduledTaskGateRunner.run")(function* (input: GateRunInput) {
    const env = yield* HostProcess.Environment;
    const output = yield* runner
      .run({
        ...shellCommand(input.command, platform, env),
        cwd: input.cwd,
        env: gateEnvironment(env),
        timeout: `${input.timeoutMs} millis`,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: GATE_OUTPUT_LIMIT_BYTES,
        outputMode: "truncate",
      })
      .pipe(Effect.result);
    if (output._tag === "Failure") {
      return {
        _tag: "SpawnFailed",
        message:
          output.failure._tag === "ProcessSpawnError"
            ? `Could not start the gate command in ${input.cwd}.`
            : "Could not read the gate command's output.",
      } satisfies GateRun;
    }
    if (output.success.timedOut) return { _tag: "TimedOut" } satisfies GateRun;
    if (output.success.code === null) {
      return {
        _tag: "SpawnFailed",
        message: "The gate command was stopped by a signal.",
      } satisfies GateRun;
    }
    return {
      _tag: "Exited",
      code: output.success.code,
      stdout: output.success.stdout,
      stderr: output.success.stderr,
    } satisfies GateRun;
  });
  return ScheduledTaskGateRunner.of({ run });
});
