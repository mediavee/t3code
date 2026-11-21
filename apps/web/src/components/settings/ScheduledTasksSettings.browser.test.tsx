import { RegistryContext } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { ConfirmDialogHost } from "../ConfirmDialogHost";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [
    {
      id: task.threadId,
      title: "Fix login bug",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    },
  ],
};

const effort = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
} as const;
const codex = ProviderInstanceId.make("codex");
const providers = [
  {
    instanceId: codex,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "model-a",
        name: "Model A",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [effort, { id: "fastMode", label: "Fast", type: "boolean" }],
        }),
      },
      {
        slug: "model-b",
        name: "Model B",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [effort] }),
      },
    ],
    slashCommands: [],
    skills: [],
  },
];
const unboundTask: ScheduledTask = {
  ...task,
  threadId: null,
  modelSelection: {
    instanceId: codex,
    model: "model-a",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
  },
};

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  unbound: false,
  remove: vi.fn(),
  upsert: vi.fn(),
}));
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.remove.mockReset().mockReturnValue(Effect.succeed({ id: task.id }));
  state.secondary = false;
  state.unbound = false;
  state.upsert.mockReset().mockImplementation(() => Effect.succeed({ task: unboundTask }));
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? { environment: { platform: "linux", capabilities: { oneTimeSchedules: true } } }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      deleteScheduledTask: {
        ...actual.serverEnvironment.deleteScheduledTask,
        run: state.remove,
      },
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        run: state.upsert,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
      providersValueAtom: (() => Atom.make(state.unbound ? providers : null)) as never,
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : { tasks: state.tasksLoaded ? [state.unbound ? unboundTask : task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("only deletes a scheduled task after confirmation, including after cancelling", async () => {
    setup();
    await using screen = await render(
      <>
        <ScheduledTasksSettings />
        <ConfirmDialogHost />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions for Review issues" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(state.remove).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(state.remove).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("button", { name: "Actions for Review issues" }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Actions for Review issues" }));
    await userEvent.click(page.getByRole("menuitem", { name: "Delete", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Confirm", exact: true }));
    await vi.waitFor(() =>
      expect(state.remove).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        environmentId,
        input: { id: task.id },
      }),
    );
  });

  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("offers no model choice for a task bound to a thread, whose runs use the thread's model", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const enabledPicker = document.querySelector(
      '[role="dialog"] [data-chat-provider-model-picker]:not(:disabled)',
    );
    expect(enabledPicker).toBeNull();
    await expect
      .element(page.getByRole("dialog").getByRole("button", { name: "gpt-5.5", exact: true }))
      .toBeDisabled();
    // Its modes are the thread's too.
    await expect
      .element(page.getByRole("dialog").getByLabelText("Permissions"))
      .toHaveTextContent("Supervised");
    await expect
      .element(page.getByRole("dialog").getByRole("switch", { name: "Plan mode" }))
      .toBeChecked();
  });

  it("edits a new-thread task's options and modes, and keeps supported options on a model change", async () => {
    setup();
    state.unbound = true;
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByRole("button", { name: /Low/ })).toBeVisible();
    await expect.element(dialog.getByLabelText("Permissions")).toHaveTextContent("Full access");
    await userEvent.click(dialog.getByRole("switch", { name: "Plan mode" }));

    await userEvent.click(dialog.getByRole("button", { name: "Model A", exact: true }));
    await userEvent.click(page.getByRole("option", { name: /Model B/ }));
    await expect.element(dialog.getByRole("button", { name: /Low/ })).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Save task" }));

    await vi.waitFor(() => expect(state.upsert).toHaveBeenCalledOnce());
    expect(state.upsert.mock.calls[0]?.[1]).toMatchObject({
      input: {
        modelSelection: {
          instanceId: codex,
          model: "model-b",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
      },
    });
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });

  it("keeps a new task's draft when the user clicks outside the editor", async () => {
    setup();
    await using _screen = await render(<ScheduledTasksSettings />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    await userEvent.click(document.body, { position: { x: 1, y: 1 } });

    await expect.element(dialog).toHaveAttribute("data-open");
    await expect.element(name).toHaveValue("My draft");
  });
});
