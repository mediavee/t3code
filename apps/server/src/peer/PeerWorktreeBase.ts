import type { PeerLinkWorktreeBaseRequest, PeerLinkWorktreeBaseResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as PeerLinks from "./PeerLinks.ts";

export class PeerWorktreeBaseRefused extends Schema.TaggedError<PeerWorktreeBaseRefused>()(
  "PeerWorktreeBaseRefused",
  { message: Schema.String },
) {}

export class PeerWorktreeBaseUnavailable extends Schema.TaggedError<PeerWorktreeBaseUnavailable>()(
  "PeerWorktreeBaseUnavailable",
  { message: Schema.String },
) {}

/** Resolves and checks the base of a delegated task's worktree here, for a linked environment. */
export class PeerWorktreeBase extends Context.Service<
  PeerWorktreeBase,
  {
    /** Whether a link may resolve a base here now; a refused caller's session is not renewed. */
    readonly admits: Effect.Effect<(caller: EnvironmentAuth.McpClientSession) => boolean>;
    readonly resolve: (
      caller: EnvironmentAuth.McpClientSession,
      request: PeerLinkWorktreeBaseRequest,
    ) => Effect.Effect<
      PeerLinkWorktreeBaseResult,
      PeerWorktreeBaseRefused | PeerWorktreeBaseUnavailable
    >;
  }
>()("t3/peer/PeerWorktreeBase") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const enabled = settings.getSettings.pipe(
    Effect.map((current) => current.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const admits: PeerWorktreeBase["Service"]["admits"] = enabled.pipe(
    Effect.map(
      (on) => (caller: EnvironmentAuth.McpClientSession) =>
        on && caller.peerLink && caller.access !== "read-only",
    ),
  );

  const resolve: PeerWorktreeBase["Service"]["resolve"] = Effect.fn("PeerWorktreeBase.resolve")(
    function* (caller, request) {
      if (!(yield* enabled)) {
        return yield* new PeerWorktreeBaseRefused({ message: PeerLinks.LINKED_ENVIRONMENTS_OFF });
      }
      // Resolving a base fetches it, which a link that may only read must not do.
      if (caller.access === "read-only") {
        return yield* new PeerWorktreeBaseRefused({
          message: "A read-only link cannot start work in a new checkout here.",
        });
      }
      const project = Option.getOrUndefined(
        yield* projects
          .getById(request.projectId)
          .pipe(
            Effect.mapError(
              () => new PeerWorktreeBaseUnavailable({ message: "The project could not be read." }),
            ),
          ),
      );
      if (project === undefined || project.deletedAt !== null) {
        return {
          outcome: "project_not_found" as const,
          message: `Project ${request.projectId} was not found.`,
        };
      }
      const notRepository = {
        outcome: "not_repository" as const,
        message: `Project "${project.title}" is not a Git repository, so it has no worktrees.`,
      };
      // A launch turns a worktree in a folder without Git into a shared checkout.
      if (yield* launches.isNonGitProject(project.id)) return notRepository;
      const baseRef =
        request.baseRef ?? (yield* GitVcsDriver.defaultWorktreeBaseRef(git, project.workspaceRoot));
      // The launch's own errors name the folder, which stays on this machine.
      return yield* launches
        .checkWorktreeBase({
          projectId: project.id,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: true },
        })
        .pipe(
          Effect.as({ outcome: "resolved" as const, baseRef, startFromOrigin: true }),
          Effect.catch((error) =>
            Effect.succeed(
              error._tag === "ThreadLaunchNotRepositoryError"
                ? notRepository
                : {
                    outcome: "base_not_found" as const,
                    message: `Base ref "${baseRef}" does not resolve to a commit in project "${project.title}".`,
                  },
            ),
          ),
        );
    },
  );

  return PeerWorktreeBase.of({ admits, resolve });
});

export const layer = Layer.effect(PeerWorktreeBase, make);
