import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpLaunchModelSelection,
  OrchestratorMcpThreadWaitResult,
  fleetWorkState,
  literalTemplateRefusal,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeThreadWaitResult = Schema.decodeUnknownSync(OrchestratorMcpThreadWaitResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });

  it("decodes a running-task next written by another version", () => {
    const next = "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
    expect(
      decodeThreadWaitResult({
        threadId: "thread-child-1",
        runId: "run-child-1",
        status: "running",
        timedOut: true,
        next,
      }).next,
    ).toBe(next);
  });

  it("refuses a key a delegate target or launch model selection does not have", () => {
    for (const target of [
      { modelSelection: { model: "gpt-5.4" } },
      JSON.stringify({ model: "gpt-5.4", effort: "max" }),
    ]) {
      expect(() => decodeDelegateTaskInput({ task: "Review.", target })).toThrow(
        /Unknown key "(modelSelection|effort)" in target\. Accepted keys: providerInstanceId, driverKind, model, options, environmentId, projectId\./,
      );
    }
    expect(
      decodeDelegateTaskInput({
        task: "Review.",
        target: { model: "gpt-5.4", options: { effort: "max" } },
      }).target,
    ).toEqual({ model: "gpt-5.4", options: [{ id: "effort", value: "max" }] });

    const decodeSelection = Schema.decodeUnknownSync(OrchestratorMcpLaunchModelSelection);
    expect(() => decodeSelection({ instanceId: "codex", model: "gpt-5.4", effort: "max" })).toThrow(
      'Unknown key "effort" in modelSelection. Accepted keys: provider, instanceId, model, options.',
    );
    expect(decodeSelection({ provider: "codex", model: "gpt-5.4" })).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
    // The record form's coercion would drop these values; the agent hears which option instead.
    for (const options of [{ effort: 3 }, { effort: "" }, { effort: " " }, { " ": "max" }]) {
      expect(() => decodeSelection({ instanceId: "codex", model: "gpt-5.4", options })).toThrow(
        `Option ${JSON.stringify(Object.keys(options)[0])} in modelSelection.options needs a non-empty id and a non-empty string or boolean value.`,
      );
    }
    expect(
      decodeSelection({
        instanceId: "codex",
        model: "gpt-5.4",
        options: { effort: " max ", fastMode: false },
      }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "effort", value: "max" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("names the placeholder or file substitution a prompt still holds", () => {
    expect(literalTemplateRefusal("task", "Review.\n\n<<BRIEF>>")).toContain('"<<BRIEF>>"');
    expect(literalTemplateRefusal("task", "Do {{ task_name }}.")).toContain('"{{ task_name }}"');
    for (const text of ["$(cat brief.md)", "x $(<brief.md) y", " `cat brief.md`\n"]) {
      expect(literalTemplateRefusal("task", text)).toContain("allowLiteralTemplates: true");
    }
    for (const text of [
      'git worktree add "$(mktemp -d)/wt"',
      '{{ secrets["NAME"].KEY }}',
      "a << b >> c",
      "run: echo ${{ github.sha }}",
      "Read it with `cat brief.md`.",
    ]) {
      expect(literalTemplateRefusal("task", text)).toBeUndefined();
    }
  });

  it.each([
    [
      "a question first",
      { status: "running", activityRunStatus: "running" },
      true,
      false,
      "needs_answer",
    ],
    [
      "a turn blocked on its children",
      { status: "running", activityRunStatus: "running", blockedOnThreadWait: true },
      false,
      false,
      "waiting_for_children",
    ],
    [
      "a running turn",
      { status: "running", activityRunStatus: "running" },
      false,
      false,
      "working",
    ],
    ["an ended turn holding work", { status: "completed" }, false, true, "waiting_for_children"],
    ["an interrupted turn", { status: "interrupted" }, false, false, "failed"],
    ["a cancelled turn", { status: "cancelled" }, false, false, "done"],
  ] as const)("reads %s as a fleet state", (_, child, needsAnswer, holds, expected) => {
    expect(fleetWorkState(child, needsAnswer, holds)).toBe(expected);
  });
});
