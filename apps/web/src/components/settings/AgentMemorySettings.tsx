import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const CEILINGS_GIB = [2, 4, 8, 16, 32, 64];

export function AgentMemorySection() {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["agentMemoryMaxGiB"]);
  // Only Linux servers run agents in systemd scopes, where the ceiling applies.
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (environment) => environment.serverConfig?.environment.platform.os === "linux",
    );
  const value = settings.agentMemoryMaxGiB;
  const options =
    value === null || CEILINGS_GIB.includes(value)
      ? CEILINGS_GIB
      : [...CEILINGS_GIB, value].sort((a, b) => a - b);
  const label = (gib: number | null) =>
    gib === null ? gt("No ceiling") : gt("{gib} GiB", { gib });

  return (
    <SettingsSection id="agent-resources" title={gt("Agent resources")}>
      <SettingsRow
        serverScoped
        settingKeys={["agentMemoryMaxGiB"]}
        {...setting("agent-memory-ceiling")}
        description={
          supported
            ? gt(
                "Memory each agent and the commands it runs can use, without swap, before the system stops it.",
              )
            : gt("Available on Linux servers, where agents run in systemd scopes.")
        }
        resetAction={
          supported && value !== DEFAULT_SERVER_SETTINGS.agentMemoryMaxGiB ? (
            <SettingResetButton
              ariaLabel={gt("Reset agent memory ceiling to default")}
              onClick={() =>
                updateSettings({ agentMemoryMaxGiB: DEFAULT_SERVER_SETTINGS.agentMemoryMaxGiB })
              }
            />
          ) : null
        }
        control={
          <Select
            disabled={!supported}
            value={mixed ? null : value === null ? "off" : String(value)}
            onValueChange={(next) => {
              if (next === null) return;
              updateSettings({ agentMemoryMaxGiB: next === "off" ? null : Number(next) });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-40"
              aria-label={gt("Agent memory ceiling")}
            >
              <SelectValue>
                {(selected: string | null) =>
                  selected === null
                    ? gt("Mixed")
                    : label(selected === "off" ? null : Number(selected))
                }
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="off">
                {label(null)}
              </SelectItem>
              {options.map((gib) => (
                <SelectItem hideIndicator key={gib} value={String(gib)}>
                  {label(gib)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
