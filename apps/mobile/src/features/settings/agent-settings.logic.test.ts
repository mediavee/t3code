import { describe, expect, it } from "vite-plus/test";

import { agentMemoryCeilingChoices, agentMemoryCeilingSupported } from "./agent-settings.logic";

describe("agent memory ceiling", () => {
  it("lists no ceiling first and keeps a value set elsewhere", () => {
    expect(agentMemoryCeilingChoices(null)).toEqual([null, 2, 4, 8, 16, 32, 64]);
    expect(agentMemoryCeilingChoices(12)).toEqual([null, 2, 4, 8, 12, 16, 32, 64]);
  });

  it("is available only when every target runs Linux", () => {
    const target = (os: string) => ({
      environment: { serverConfig: { environment: { platform: { os } } } },
    });
    expect(agentMemoryCeilingSupported([target("linux"), target("linux")])).toBe(true);
    expect(agentMemoryCeilingSupported([target("linux"), target("darwin")])).toBe(false);
    expect(agentMemoryCeilingSupported([])).toBe(false);
  });
});
