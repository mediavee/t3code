import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_FALLBACK_POLL_MS = 10_000;

/**
 * Subscribes to desktop push notifications when available, falling back to a slow
 * poll only for older preloads without `onLocalEnvironmentsChanged`. Failed reads
 * retain the latest successful snapshot, while a successful empty read clears it.
 */
export function createDesktopLocalBootstrapsAtom(
  resolveBridge: () =>
    | Pick<
        NonNullable<Window["desktopBridge"]>,
        "getLocalEnvironmentBootstraps" | "onLocalEnvironmentsChanged"
      >
    | undefined = () => (typeof window !== "undefined" ? window.desktopBridge : undefined),
  readBootstraps: () => ReadonlyArray<DesktopEnvironmentBootstrap> = readDesktopSecondaryBootstraps,
) {
  return Atom.make((get) => {
    const bridge = resolveBridge();
    if (bridge?.onLocalEnvironmentsChanged !== undefined) {
      const unsubscribe = bridge.onLocalEnvironmentsChanged(() => get.setSelf(readBootstraps()));
      get.addFinalizer(unsubscribe);
    } else if (bridge !== undefined) {
      const interval = setInterval(
        () => get.setSelf(readBootstraps()),
        DESKTOP_LOCAL_BOOTSTRAP_FALLBACK_POLL_MS,
      );
      get.addFinalizer(() => clearInterval(interval));
    }
    return readBootstraps();
  }).pipe(Atom.withLabel("desktop-local-bootstraps"));
}

const desktopLocalBootstrapsAtom = createDesktopLocalBootstrapsAtom();

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
