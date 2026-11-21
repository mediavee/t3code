import type { ThreadFleetRollup } from "@t3tools/client-runtime/state/thread-fleet";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fleet: null as ThreadFleetRollup | null,
  openThread: (() => {}) as (thread: unknown) => void,
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../state/threads", () => ({
  threadFleetAtom: () => Atom.make(mocks.fleet),
}));
vi.mock("./useOpenThreadLink", () => ({
  useOpenThreadLink: () => mocks.openThread,
}));

import { ThreadFleetStrip } from "./ThreadFleetStrip";

const environmentId = EnvironmentId.make("environment-1");
const parent = { environmentId, threadId: ThreadId.make("thread-parent") };
const waitedLongest = { environmentId, threadId: ThreadId.make("thread-asking") };

function setup(fleet: ThreadFleetRollup | null) {
  mocks.fleet = fleet;
  mocks.openThread = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<ThreadFleetStrip threadRef={parent} />));
  return {
    container,
    openThread: mocks.openThread,
    [Symbol.dispose]: () => act(() => root.unmount()),
  };
}

describe("ThreadFleetStrip", () => {
  it("shows each non-zero count and opens the child that has waited longest", () => {
    using screen = setup({
      running: 2,
      blocked: 1,
      failed: 0,
      done: 3,
      openPullRequests: 1,
      firstBlocked: waitedLongest,
    });
    expect(
      Array.from(screen.container.querySelectorAll("button, span"), (node) => node.textContent),
    ).toEqual(["1 waiting for an answer", "2 running", "3 done", "1 open PR"]);

    act(() => screen.container.querySelector("button")!.click());
    expect(screen.openThread).toHaveBeenCalledWith(waitedLongest);
  });

  it("shows nothing for a thread that started no children", () => {
    using screen = setup(null);
    expect(screen.container.innerHTML).toBe("");
  });
});
