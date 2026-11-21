// @effect-diagnostics nodeBuiltinImport:off -- the fixture plants real directories and symlinks.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { threadTempDirectory } from "../process/agentScope.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const layer = ResourceCleanupService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
      Layer.mock(PreviewManager.PreviewManager)({}),
      Layer.mock(DeviceService.DeviceService)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-cleanup-" })),
  Layer.provideMerge(NodeServices.layer),
);

// Archive and delete both queue terminal.cleanup for the thread.
it.effect(
  "removes the thread's temp directory with its terminals, without following symlinks",
  () =>
    Effect.gen(function* () {
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const outside = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-resource-cleanup-out-"),
      );
      NodeFS.writeFileSync(NodePath.join(outside, "keep"), "x");
      const directory = threadTempDirectory(stateDir, "thread-archived");
      NodeFS.mkdirSync(NodePath.join(directory, "nested"), { recursive: true });
      NodeFS.symlinkSync(outside, NodePath.join(directory, "nested", "link"));
      const other = threadTempDirectory(stateDir, "thread-live");
      NodeFS.mkdirSync(other);

      yield* cleanup.cleanupTerminals("thread-archived");
      // A thread that never ran an agent has no directory to remove.
      yield* cleanup.cleanupTerminals("thread-never-ran");

      expect(NodeFS.existsSync(directory)).toBe(false);
      expect(NodeFS.existsSync(other)).toBe(true);
      expect(NodeFS.readFileSync(NodePath.join(outside, "keep"), "utf8")).toBe("x");
      NodeFS.rmSync(outside, { recursive: true, force: true });
    }).pipe(Effect.provide(layer)),
);
