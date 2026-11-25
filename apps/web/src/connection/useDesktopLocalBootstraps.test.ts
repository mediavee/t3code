import { type DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createDesktopSecondaryBootstrapsReader } from "./desktopLocal";
import { createDesktopLocalBootstrapsAtom } from "./useDesktopLocalBootstraps";

const SECONDARY: DesktopEnvironmentBootstrap = {
  id: "wsl:Ubuntu",
  label: "WSL (Ubuntu)",
  runningDistro: "Ubuntu",
  httpBaseUrl: "http://127.0.0.1:4000/",
  wsBaseUrl: "ws://127.0.0.1:4000/",
  bootstrapToken: "token-1",
};

describe("desktopLocalBootstrapsAtom", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses push notifications without polling intervals when onLocalEnvironmentsChanged is available", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    let entries: DesktopEnvironmentBootstrap[] = [];
    const listeners = new Set<() => void>();
    const bridge = {
      getLocalEnvironmentBootstraps: vi.fn(() => entries),
      onLocalEnvironmentsChanged: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    };
    const reader = createDesktopSecondaryBootstrapsReader(() => bridge);
    const atom = createDesktopLocalBootstrapsAtom(
      () => bridge,
      () => reader.readSnapshot(),
    );
    const registry = AtomRegistry.make();
    const observed: Array<ReadonlyArray<DesktopEnvironmentBootstrap>> = [];
    const unsubscribe = registry.subscribe(atom, (value) => observed.push(value), {
      immediate: true,
    });

    expect(observed).toEqual([[]]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(bridge.getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(1);

    entries = [SECONDARY];
    for (const listener of listeners) listener();

    expect(observed).toEqual([[], [SECONDARY]]);
    expect(bridge.getLocalEnvironmentBootstraps).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    unsubscribe();
    registry.dispose();
    expect(listeners.size).toBe(0);
  });

  it("falls back to a slow interval only when onLocalEnvironmentsChanged is unavailable", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    let entries: DesktopEnvironmentBootstrap[] = [];
    const bridge = {
      getLocalEnvironmentBootstraps: vi.fn(() => entries),
    };
    const reader = createDesktopSecondaryBootstrapsReader(() => bridge);
    const atom = createDesktopLocalBootstrapsAtom(
      () => bridge,
      () => reader.readSnapshot(),
    );
    const registry = AtomRegistry.make();
    const observed: Array<ReadonlyArray<DesktopEnvironmentBootstrap>> = [];
    const unsubscribe = registry.subscribe(atom, (value) => observed.push(value), {
      immediate: true,
    });

    expect(observed).toEqual([[]]);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    entries = [SECONDARY];
    vi.advanceTimersByTime(9_999);
    expect(observed).toEqual([[]]);

    vi.advanceTimersByTime(1);
    expect(observed).toEqual([[], [SECONDARY]]);

    unsubscribe();
    registry.dispose();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("schedules no polling intervals when no desktop bridge is present", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const reader = createDesktopSecondaryBootstrapsReader(() => undefined);
    const atom = createDesktopLocalBootstrapsAtom(
      () => undefined,
      () => reader.readSnapshot(),
    );
    const registry = AtomRegistry.make();
    const unsubscribe = registry.subscribe(atom, () => {}, { immediate: true });

    expect(setIntervalSpy).not.toHaveBeenCalled();

    unsubscribe();
    registry.dispose();
  });
});
