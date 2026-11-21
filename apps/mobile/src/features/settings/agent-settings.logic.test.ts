import { STANDING_INSTRUCTIONS_MAX_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentMemoryCeilingChoices,
  agentMemoryCeilingSupported,
  standingInstructionsPatch,
} from "./agent-settings.logic";

describe("standingInstructionsPatch", () => {
  it.each([
    ["no draft", undefined, "Ask first.", {}],
    ["an unchanged draft", { text: " Ask first. ", over: "Ask first." }, "Ask first.", {}],
    [
      "an edited draft, trimmed",
      { text: " Merge when green.\n", over: "Ask first." },
      "Ask first.",
      { standingInstructions: "Merge when green." },
    ],
    [
      "a cleared draft",
      { text: "  ", over: "Ask first." },
      "Ask first.",
      { standingInstructions: "" },
    ],
    // A newer saved value has remounted the field, so the old draft must not overwrite it.
    ["a draft typed over an older value", { text: "Old.", over: "Older." }, "Newer.", {}],
    ["any draft over mixed values", { text: "", over: null }, null, { standingInstructions: "" }],
  ] as const)("%s", (_name, draft, saved, patch) => {
    expect(standingInstructionsPatch(draft, saved)).toEqual(patch);
  });

  it("keeps the saved text within the server's bound", () => {
    const text = "a".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH + 10);
    expect(standingInstructionsPatch({ text, over: "" }, "").standingInstructions).toHaveLength(
      STANDING_INSTRUCTIONS_MAX_LENGTH,
    );
  });
});

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
