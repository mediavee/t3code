import type { DesktopBridge, DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "./ipc/channels.ts";

describe("desktop preload local environment cache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("caches local environment sync reads and invalidates on push events, setter, and TTL", async () => {
    const ipcListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let bootstraps: DesktopEnvironmentBootstrap[] = [
      {
        id: "primary",
        label: "Local",
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    ];
    let localEnabled = true;

    const sendSync = vi.fn((channel: string) => {
      if (channel === IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL) return bootstraps;
      if (channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) return localEnabled;
      if (channel === IpcChannels.GET_PRIMARY_PASTE_ENABLED_CHANNEL) return true;
      return undefined;
    });
    const invoke = vi.fn(async (channel: string, value?: unknown) => {
      if (channel === IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) {
        localEnabled = Boolean(value);
      }
      return undefined;
    });
    const exposed = new Map<string, unknown>();

    vi.doMock("@clerk/electron/preload", () => ({
      exposeClerkBridge: vi.fn(),
    }));
    vi.doMock("electron", () => ({
      contextBridge: {
        exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api),
      },
      ipcRenderer: {
        sendSync,
        invoke,
        on: (channel: string, listener: (...args: unknown[]) => void) => {
          let set = ipcListeners.get(channel);
          if (!set) {
            set = new Set();
            ipcListeners.set(channel, set);
          }
          set.add(listener);
        },
        removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
          ipcListeners.get(channel)?.delete(listener);
        },
        off: (channel: string, listener: (...args: unknown[]) => void) => {
          ipcListeners.get(channel)?.delete(listener);
        },
      },
      webFrame: { getZoomFactor: () => 1 },
      webUtils: { getPathForFile: () => "" },
    }));

    const doc = Object.assign(new EventTarget(), {
      fullscreenElement: null,
      documentElement: { style: { setProperty: vi.fn() } },
    });
    const win = Object.assign(new EventTarget(), {
      document: doc,
      localStorage: { getItem: () => null, setItem: () => undefined },
    });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    await import("./preload.ts");

    const bridge = exposed.get("desktopBridge") as DesktopBridge;
    expect(bridge).toBeDefined();
    expect(typeof bridge.onLocalEnvironmentsChanged).toBe("function");

    const bootstrapCalls = () =>
      sendSync.mock.calls.filter(
        ([channel]) => channel === IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL,
      ).length;
    const enabledCalls = () =>
      sendSync.mock.calls.filter(
        ([channel]) => channel === IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
      ).length;

    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(bootstraps);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(bootstraps);
    expect(bootstrapCalls()).toBe(1);

    expect(bridge.getLocalEnvironmentEnabled()).toBe(true);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(true);
    expect(enabledCalls()).toBe(1);

    // Push event invalidates caches before notifying renderer listeners.
    let observedInListener: readonly DesktopEnvironmentBootstrap[] = [];
    const unsubscribe = bridge.onLocalEnvironmentsChanged!(() => {
      observedInListener = bridge.getLocalEnvironmentBootstraps();
    });

    const nextBootstraps: DesktopEnvironmentBootstrap[] = [
      ...bootstraps,
      {
        id: "wsl:Ubuntu",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        bootstrapToken: "tok-2",
      },
    ];
    bootstraps = nextBootstraps;
    for (const handler of ipcListeners.get(IpcChannels.LOCAL_ENVIRONMENTS_CHANGED_CHANNEL) ?? []) {
      handler({});
    }

    expect(observedInListener).toEqual(nextBootstraps);
    expect(bootstrapCalls()).toBe(2);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(nextBootstraps);
    expect(bootstrapCalls()).toBe(2);

    // Setter invalidates the enabled cache even without a push event.
    await bridge.setLocalEnvironmentEnabled(false);
    expect(bridge.getLocalEnvironmentEnabled()).toBe(false);
    expect(enabledCalls()).toBe(2);

    // TTL expires bootstrap cache after 5 minutes so rotated tokens are picked up.
    vi.advanceTimersByTime(5 * 60_000);
    expect(bridge.getLocalEnvironmentBootstraps()).toEqual(nextBootstraps);
    expect(bootstrapCalls()).toBe(3);

    unsubscribe();
  });
});
