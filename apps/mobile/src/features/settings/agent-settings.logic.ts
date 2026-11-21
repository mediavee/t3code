export const AGENT_MEMORY_CEILINGS_GIB = [2, 4, 8, 16, 32, 64] as const;

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
