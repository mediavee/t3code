import { STANDING_INSTRUCTIONS_MAX_LENGTH, type ServerSettingsPatch } from "@t3tools/contracts";

export const AGENT_MEMORY_CEILINGS_GIB = [2, 4, 8, 16, 32, 64] as const;

/** The draft typed in the field and the saved value it was typed over; null saved is mixed. */
export interface StandingInstructionsDraft {
  readonly text: string;
  readonly over: string | null;
}

/**
 * A draft typed over an older saved value is dropped: the newer value has already replaced the
 * field. A mixed selection saves any draft, so every target gets the same instructions.
 */
export function standingInstructionsPatch(
  draft: StandingInstructionsDraft | undefined,
  saved: string | null,
): ServerSettingsPatch {
  if (draft === undefined || draft.over !== saved) return {};
  const value = draft.text.trim().slice(0, STANDING_INSTRUCTIONS_MAX_LENGTH);
  return saved === null || value !== saved ? { standingInstructions: value } : {};
}

/** Choices for the ceiling, keeping a value set elsewhere, such as in settings.json. */
export function agentMemoryCeilingChoices(current: number | null): ReadonlyArray<number | null> {
  const values: number[] = [...AGENT_MEMORY_CEILINGS_GIB];
  if (current !== null && !values.includes(current)) values.push(current);
  return [null, ...values.sort((a, b) => a - b)];
}

/** Only Linux servers run agents in systemd scopes, where the ceiling applies. */
export function agentMemoryCeilingSupported(
  targets: ReadonlyArray<{
    readonly environment: {
      readonly serverConfig: {
        readonly environment: { readonly platform: { readonly os: string } };
      };
    };
  }>,
): boolean {
  return (
    targets.length > 0 &&
    targets.every((target) => target.environment.serverConfig.environment.platform.os === "linux")
  );
}
