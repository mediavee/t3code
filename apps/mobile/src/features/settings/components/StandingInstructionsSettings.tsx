import { STANDING_INSTRUCTIONS_MAX_LENGTH, type ServerSettingsPatch } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";
import { useSettingsTextDrafts } from "./useSettingsTextDrafts";

export function StandingInstructionsSettings(props: {
  /** Null when the selected targets differ. */
  readonly value: string | null;
  readonly disabled: boolean;
  readonly footer?: string | undefined;
  readonly onChange: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
  const drafts = useSettingsTextDrafts({ standingInstructions: props.value });
  const save = () => {
    const value = drafts.unsaved("standingInstructions");
    // Save even while disabled; the route queues behind pending writes and checks access.
    if (value !== undefined)
      props.onChange({ standingInstructions: value.slice(0, STANDING_INSTRUCTIONS_MAX_LENGTH) });
  };
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const saveOnExit = useEffectEvent(save);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent standing instructions draft to server settings when the section unmounts
  useEffect(() => () => saveOnExit(), []);
  return (
    <SettingsSection title={gt("Agents")} footer={props.footer}>
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          {gt(
            "Given to every agent in this scope, on every provider, including the agents they start.",
          )}
        </Text>
        <AppTextInput
          key={props.value}
          accessibilityLabel={gt("Standing instructions")}
          onChangeText={(text) => drafts.edit("standingInstructions", text)}
          defaultValue={props.value ?? ""}
          placeholder={
            props.value === null
              ? gt("Mixed. Enter instructions to apply to all selected targets.")
              : gt("Merge and deploy when checks pass. Ask before restarting shared services.")
          }
          editable={!props.disabled}
          maxLength={STANDING_INSTRUCTIONS_MAX_LENGTH}
          multiline
          autoCapitalize="sentences"
          className="min-h-32 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={save}
        />
      </View>
    </SettingsSection>
  );
}
