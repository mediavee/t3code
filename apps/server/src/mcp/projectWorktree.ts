import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** An agent may bind work only to a checkout the project's repository lists as its worktree. */
export const assertProjectWorktree = Effect.fn("mcp.assertProjectWorktree")(function* (
  workspaceRoot: string,
  worktreePath: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Without a file system, paths compare as given: a symlinked spelling is refused, never let through.
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const real = (path: string) =>
    Option.isNone(fileSystem)
      ? Effect.succeed(path)
      : fileSystem.value.realPath(path).pipe(Effect.orElseSucceed(() => path));
  const worktrees = yield* git.listWorktreePaths(workspaceRoot).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, real)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
  if (!worktrees.includes(yield* real(worktreePath)))
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "worktreePath must be one of the project's git worktrees. t3_worktree_list shows them.",
    });
});
