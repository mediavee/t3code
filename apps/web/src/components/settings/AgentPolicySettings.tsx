import {
  type ModelSelection,
  type OrchestratorMcpTaskRole,
  STANDING_INSTRUCTIONS_MAX_LENGTH,
} from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { msg, useGT, useMessages } from "gt-react";
import { useRef } from "react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { resolveDefaultModelSettingsPresentation } from "./ProjectDefaultsSettings.logic";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const ROLES = [
  { role: "implementation", label: msg("Implementation") },
  { role: "review", label: msg("Review") },
  { role: "research", label: msg("Research") },
  { role: "design", label: msg("Design") },
  { role: "test", label: msg("Test") },
  { role: "general", label: msg("General") },
] as const satisfies ReadonlyArray<{ role: OrchestratorMcpTaskRole; label: string }>;

export function AgentPolicySettingsSection() {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments, targets, target } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const projectId = target?.projectId ?? null;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, entries);
  const mixedInstructions = useScopedSettingsMixed(["standingInstructions"]);
  const mixedRoles = useScopedSettingsMixed(["agentRoleModels"]);
  const instructionsEdited = useRef(false);
  const scopeKey = targets.map((entry) => `${entry.environmentId}:${entry.projectId}`).join(",");
  const seed = resolveDefaultModelSettingsPresentation(
    { entries, providers, settings, projectId },
    m,
  ).selection;
  const roleModels = settings.agentRoleModels;

  const setRole = (role: OrchestratorMcpTaskRole, selection: ModelSelection | null) => {
    const reason = selection ? modelDisabledReason(selection.instanceId, selection.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: gt("Role model not saved"), description: reason });
      return;
    }
    const others = Object.fromEntries(
      Object.entries(roleModels).filter(([candidate]) => candidate !== role),
    );
    updateSettings({ agentRoleModels: selection ? { ...others, [role]: selection } : others });
  };

  return (
    <SettingsSection id="agent-policy" title={gt("Agents")}>
      <SettingsRow
        serverScoped
        settingKeys={["standingInstructions"]}
        {...setting("standing-instructions")}
        description={gt(
          "Given to every agent in this scope, on every provider, including the agents they start.",
        )}
        resetAction={
          mixedInstructions || settings.standingInstructions !== "" ? (
            <SettingResetButton
              ariaLabel={gt("Reset standing instructions to default")}
              onClick={() => updateSettings({ standingInstructions: "" })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${scopeKey}:${mixedInstructions}:${settings.standingInstructions}`}
            aria-label={gt("Standing instructions")}
            maxLength={STANDING_INSTRUCTIONS_MAX_LENGTH}
            onChange={() => {
              instructionsEdited.current = true;
            }}
            rows={6}
            defaultValue={mixedInstructions ? "" : settings.standingInstructions}
            placeholder={
              mixedInstructions
                ? gt("Mixed. Enter instructions to apply to all selected targets.")
                : gt("Merge and deploy when checks pass. Ask before restarting shared services.")
            }
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (
                instructionsEdited.current &&
                (mixedInstructions || value !== settings.standingInstructions)
              )
                updateSettings({ standingInstructions: value });
              instructionsEdited.current = false;
            }}
          />
        </div>
      </SettingsRow>
      {ROLES.map(({ role, label }) => {
        const selection = roleModels[role];
        const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
        return (
          <SettingsRow
            key={role}
            serverScoped
            settingKeys={["agentRoleModels"]}
            mixed={mixedRoles}
            {...(role === "implementation" ? setting("role-models") : {})}
            title={gt("{role} model", { role: m(label) })}
            description={gt(
              "Delegated tasks with this role run here unless the agent names a provider or model. Off inherits the parent's model.",
            )}
            status={
              mixedRoles
                ? gt("The selected targets use different role models. Select one to edit.")
                : null
            }
            control={
              connectedEnvironments.length === 0 || mixedRoles ? null : (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  {selection ? (
                    <ProviderModelPicker
                      environmentId={environmentId}
                      activeInstanceId={selection.instanceId}
                      model={selection.model}
                      lockedProvider={null}
                      instanceEntries={entries}
                      modelOptionsByInstance={getCustomModelOptionsByInstance(
                        settings,
                        providers,
                        selection.instanceId,
                        selection.model,
                      )}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      triggerAriaLabel={gt("{role} model", { role: m(label) })}
                      getModelDisabledReason={modelDisabledReason}
                      onInstanceModelChange={(instanceId, model) =>
                        setRole(role, pickModelSelection(selection, instanceId, model))
                      }
                    />
                  ) : null}
                  {selection && entry ? (
                    <TraitsPicker
                      provider={entry.driverKind}
                      models={entry.models}
                      model={selection.model}
                      modelOptions={selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setRole(
                          role,
                          createModelSelection(selection.instanceId, selection.model, options),
                        )
                      }
                    />
                  ) : null}
                  <Switch
                    checked={selection !== undefined}
                    disabled={selection === undefined && seed === null}
                    onCheckedChange={(checked) => setRole(role, checked ? seed : null)}
                    aria-label={gt("Use a model for the {role} role", { role: m(label) })}
                  />
                </div>
              )
            }
          />
        );
      })}
    </SettingsSection>
  );
}
