import { DEFAULT_SERVER_SETTINGS, ProjectId, type ServerSettingsPatch } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: {
    branchNaming: { onChange: (_patch: ServerSettingsPatch) => {} },
    standingInstructions: {
      onChange: (_patch: ServerSettingsPatch) => {},
      value: null as string | null,
      disabled: false,
    },
    updateSettings: vi.fn(),
    alert: vi.fn(),
    targets: [] as ReturnType<typeof environment>[],
    readOnly: new Set<string>(),
    projectSelected: false,
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Alert: { alert: mocks.alert },
  Pressable: ({
    children,
    disabled,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => (
    <button disabled={disabled} onClick={onPress} aria-label={accessibilityLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => AsyncResult.success({}),
  useAtomSet: () => () => {},
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
  saveMobilePreferences: {},
}));
vi.mock("./components/AutoSettleDaysField", () => ({ AutoSettleDaysField: () => null }));
vi.mock("./components/IssueTrackerSection", () => ({ IssueTrackerSection: () => null }));
vi.mock("./components/SourceControlProvidersSection", () => ({
  SourceControlProvidersSection: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({}) }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () =>
    new Set(
      mocks.targets
        .map((target) => target.environmentId)
        .filter((environmentId) => !mocks.readOnly.has(environmentId)),
    ),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.updateSettings,
}));
vi.mock("../threads/thread-settings-options", () => ({
  RUNTIME_MODE_CHOICES: [],
  withManagedRuntimeModeLimits: (choices: readonly unknown[]) => choices,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => ({
    title: "Filter",
    icon: "line.3.horizontal.decrease.circle",
    items: [],
  }),
}));
vi.mock("./components/DatabaseStorageNotice", () => ({ DatabaseStorageNotice: () => null }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({
    children,
    footer,
    trailing,
  }: {
    children?: ReactNode;
    footer?: ReactNode;
    trailing?: ReactNode;
  }) => (
    <>
      {trailing}
      {children}
      {footer}
    </>
  ),
}));
vi.mock("../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: ({
    label,
    selected,
    disabled,
    onPress,
  }: {
    label: string;
    selected: boolean;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button role="radio" aria-checked={selected} disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean | null;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value ?? "mixed"}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    >
      {label}
    </button>
  ),
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/BranchNamingSettings", () => ({
  BranchNamingSettings: (props: { onChange: (patch: ServerSettingsPatch) => void }) => {
    mocks.branchNaming.onChange = props.onChange;
    return null;
  },
}));
vi.mock("./components/StandingInstructionsSettings", () => ({
  StandingInstructionsSettings: (props: {
    value: string | null;
    disabled: boolean;
    onChange: (patch: ServerSettingsPatch) => void;
  }) => {
    mocks.standingInstructions = props;
    return null;
  },
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: mocks.targets,
    projectGroups: [
      {
        key: "project",
        label: "Project",
        members: mocks.targets.map((target) => ({
          project: { environmentId: target.environmentId, id: "project" },
        })),
      },
    ],
    selectedProjectKey: mocks.projectSelected ? "project" : null,
  }),
}));

import {
  SettingsEnvironmentMaintenanceRouteScreen,
  SettingsThreadsRouteScreen,
  SettingsWorktreesRouteScreen,
} from "./SettingsServerControlsRouteScreen";

function environment(environmentId: string, label: string, os = "linux") {
  return {
    environmentId,
    label,
    connection: { phase: "connected" },
    serverConfig: {
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        defaultAutoPull: false,
        sidebarAutoSettleOnMerge: false,
      },
      environment: {
        platform: { os },
        capabilities: { projectSettingsOverrides: true, threadAutoSettlement: true },
      },
    },
  };
}

let root: Root;
let container: HTMLDivElement;

const maskSwitch = () =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (button) => button.textContent === "Mask secrets in tool output",
  )!;
const resetButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Reset",
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.targets = [environment("local", "Local")];
  mocks.projectSelected = false;
  mocks.readOnly = new Set();
  mocks.alert.mockReset();
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue(AsyncResult.success(undefined));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("SettingsServerControlsRouteScreen", () => {
  it("sends a draft saved during a pending write once that write settles", async () => {
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsWorktreesRouteScreen />));

    act(() => mocks.branchNaming.onChange({ branchNamingMode: "custom" }));
    act(() => mocks.branchNaming.onChange({ branchNameInstructions: "Use issue IDs." }));
    expect(mocks.updateSettings).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    expect(mocks.updateSettings).toHaveBeenCalledTimes(2);
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: {
        patch: { branchNamingMode: "custom", branchNameInstructions: "Use issue IDs." },
      },
    });
  });

  it("holds auto-settle changes until a pending project override write settles", async () => {
    mocks.projectSelected = true;
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsThreadsRouteScreen />));
    const toggle = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
        (button) => button.textContent === label,
      )!;

    act(() => toggle("Agent browser access").click());
    act(() => toggle("Auto-settle merged threads").click());

    // Both rewrite the whole project override, so a second write planned now would drop the first.
    expect(mocks.updateSettings).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(AsyncResult.success(undefined)));
  });

  it("saves provider-error resume and standing instructions from the threads page", () => {
    act(() => root.render(<SettingsThreadsRouteScreen />));
    const resume = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Resume after provider errors",
    )!;
    expect(resume.getAttribute("aria-checked")).toBe("true");
    expect(mocks.standingInstructions.value).toBe("");
    expect(mocks.standingInstructions.disabled).toBe(false);

    act(() => resume.click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { autoRetryTransientFailures: false } },
    });
  });

  it("saves standing instructions for the environment", () => {
    act(() => root.render(<SettingsThreadsRouteScreen />));
    act(() => mocks.standingInstructions.onChange({ standingInstructions: "Ask first." }));
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: { patch: { standingInstructions: "Ask first." } },
    });
  });

  it("overrides standing instructions for a project and resets them", async () => {
    mocks.projectSelected = true;
    const pending = Promise.withResolvers<AsyncResult.Success<void>>();
    mocks.updateSettings.mockReturnValueOnce(pending.promise);
    act(() => root.render(<SettingsThreadsRouteScreen />));
    act(() => mocks.standingInstructions.onChange({ standingInstructions: "Project rules." }));
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId: "local",
      input: {
        patch: {
          projectSettingsOverrides: { project: { standingInstructions: "Project rules." } },
        },
      },
    });
    await act(async () => pending.resolve(AsyncResult.success(undefined)));

    const local = environment("local", "Local");
    local.serverConfig.settings.projectSettingsOverrides = {
      [ProjectId.make("project")]: { standingInstructions: "Project rules." },
    };
    mocks.targets = [local];
    // The compiled screen memoizes its page, so new targets need a fresh mount.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<SettingsThreadsRouteScreen />));
    expect(mocks.standingInstructions.value).toBe("Project rules.");
    const useDefaults = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Use defaults",
    )!;
    act(() => useDefaults.click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { projectSettingsOverrides: { project: null } } },
    });
  });

  it("keeps environment-wide agent settings read-only while a project is selected", () => {
    mocks.projectSelected = true;
    act(() => root.render(<SettingsThreadsRouteScreen />));
    const resume = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Resume after provider errors",
    )!;
    expect(resume.disabled).toBe(true);
    expect(mocks.standingInstructions.disabled).toBe(false);

    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const ceilings = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(ceilings.length).toBeGreaterThan(0);
    expect(ceilings.every((button) => button.disabled)).toBe(true);
    expect(maskSwitch().disabled).toBe(true);
    expect(container.textContent).toContain(
      "Environment-wide setting. Select All projects to change it.",
    );
  });

  it("keeps the agent settings read-only without settings access", () => {
    mocks.readOnly = new Set(["local"]);
    act(() => root.render(<SettingsThreadsRouteScreen />));
    const resume = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Resume after provider errors",
    )!;
    expect(resume.disabled).toBe(true);
    expect(mocks.standingInstructions.disabled).toBe(true);

    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const ceilings = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(ceilings.length).toBeGreaterThan(0);
    expect(ceilings.every((button) => button.disabled)).toBe(true);
    expect(maskSwitch().disabled).toBe(true);
  });

  it("turns secret masking off for the environment and resets it to default", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(maskSwitch().getAttribute("aria-checked")).toBe("true");
    expect(resetButton()).toBeUndefined();
    act(() => maskSwitch().click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { maskSecretsInToolOutput: false } },
    });

    const off = environment("local", "Local");
    off.serverConfig.settings.maskSecretsInToolOutput = false;
    mocks.targets = [off];
    // A fresh root: the compiled screen memoizes on its props, and these did not change.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    expect(maskSwitch().getAttribute("aria-checked")).toBe("false");
    act(() => resetButton()!.click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { maskSecretsInToolOutput: true } },
    });
  });

  it("sets the agent memory ceiling on Linux", () => {
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const ceiling = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (button) => button.textContent === label,
      )!;
    expect(ceiling("No ceiling").getAttribute("aria-checked")).toBe("true");
    act(() => ceiling("8 GiB").click());
    expect(mocks.updateSettings).toHaveBeenLastCalledWith({
      environmentId: "local",
      input: { patch: { agentMemoryMaxGiB: 8 } },
    });
  });

  it("explains that the agent memory ceiling needs Linux on every target", () => {
    mocks.targets = [environment("local", "Local"), environment("mac", "Mac", "darwin")];
    act(() => root.render(<SettingsEnvironmentMaintenanceRouteScreen />));
    const ceiling = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (button) => button.textContent === "8 GiB",
    )!;
    expect(ceiling.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Available on Linux servers, where agents run in systemd scopes.",
    );
  });

  it("disables auto-settle when a selected environment cannot save settings", () => {
    const remote = environment("remote", "Remote");
    // Auto-settle rows skip a server without auto-settlement, but the page still saves to it.
    remote.serverConfig.environment.capabilities.threadAutoSettlement = false;
    mocks.targets = [environment("local", "Local"), remote];
    mocks.readOnly = new Set(["remote"]);
    act(() => root.render(<SettingsThreadsRouteScreen />));

    const autoSettle = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
      (button) => button.textContent === "Auto-settle merged threads",
    )!;
    expect(autoSettle.disabled).toBe(true);
  });
});
