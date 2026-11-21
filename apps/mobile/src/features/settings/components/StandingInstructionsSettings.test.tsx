import { STANDING_INSTRUCTIONS_MAX_LENGTH } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  defaultValue: string;
  editable: boolean;
  onChangeText: (text: string) => void;
  onEndEditing: (event: { nativeEvent: { text: string } }) => void;
};

const inputs = vi.hoisted(() => new Map<string, InputProps>());

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: InputProps) => {
    inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { StandingInstructionsSettings } from "./StandingInstructionsSettings";

let root: Root;
const onChange = vi.fn();

function render(value: string | null = "Ask first.", disabled = false) {
  act(() =>
    root.render(
      <StandingInstructionsSettings value={value} disabled={disabled} onChange={onChange} />,
    ),
  );
}

// Android Back hides the keyboard without ending editing; leaving then only unmounts.
function leaveScreen() {
  act(() => root.unmount());
  root = createRoot(document.createElement("div"));
}

function field() {
  const props = inputs.get("Standing instructions");
  if (!props) throw new Error("Standing instructions input not rendered");
  return props;
}

const type = (text: string) => act(() => field().onChangeText(text));
const endEditing = () => act(() => field().onEndEditing({ nativeEvent: { text: "" } }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  inputs.clear();
  onChange.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("StandingInstructionsSettings", () => {
  it("saves trimmed instructions when editing ends, within the server's bound", () => {
    render();
    type(" Merge when green.\n");
    endEditing();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ standingInstructions: "Merge when green." });

    onChange.mockClear();
    render("Merge when green.");
    type("a".repeat(STANDING_INSTRUCTIONS_MAX_LENGTH + 10));
    endEditing();
    expect(onChange.mock.calls[0]?.[0].standingInstructions).toHaveLength(
      STANDING_INSTRUCTIONS_MAX_LENGTH,
    );
  });

  it("saves a draft when the screen closes before editing ends", () => {
    render();
    type("Merge when green.");
    leaveScreen();

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ standingInstructions: "Merge when green." });
  });

  it("saves nothing for an unchanged draft and any draft over mixed values", () => {
    render();
    type(" Ask first. ");
    endEditing();
    expect(onChange).not.toHaveBeenCalled();

    render(null);
    type("");
    leaveScreen();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ standingInstructions: "" });
  });

  it("still saves a draft when a pending write disables the field", () => {
    render();
    type("Merge when green.");
    render("Ask first.", true);
    expect(field().editable).toBe(false);
    leaveScreen();

    expect(onChange).toHaveBeenCalledExactlyOnceWith({ standingInstructions: "Merge when green." });
  });

  it("drops a draft once a newer saved value replaces the field", () => {
    render();
    type("Old draft.");
    render("Saved elsewhere.");
    expect(field().defaultValue).toBe("Saved elsewhere.");
    leaveScreen();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("drops a draft when the saved value changes and changes back", () => {
    render();
    type("Old draft.");
    render("Saved elsewhere.");
    render("Ask first.");
    leaveScreen();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("retries a save that did not land and writes a saved one once", () => {
    render();
    type("Merge when green.");
    endEditing();
    // The write failed, so the saved value is still the old one.
    endEditing();
    leaveScreen();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith({ standingInstructions: "Merge when green." });

    onChange.mockClear();
    render();
    type("Merge when green.");
    endEditing();
    render("Merge when green.");
    leaveScreen();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ standingInstructions: "Merge when green." });
  });
});
