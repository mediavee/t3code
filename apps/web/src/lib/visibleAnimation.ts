import { getDocumentActivity, subscribeDocumentActivity } from "./documentActivity";

interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
let rootTrackingCount = 0;
let unsubscribeDocumentActivity: (() => void) | null = null;
let batteryTrackingCount = 0;
let unsubscribePowerState: (() => void) | null = null;
let onBatteryPower = false;

function isWindowActive(): boolean {
  const { visible, focused } = getDocumentActivity();
  return visible && focused;
}

function syncRootBlurredAttribute() {
  if (rootTrackingCount === 0 || typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  if (isWindowActive()) {
    delete root.dataset.windowBlurred;
  } else {
    root.dataset.windowBlurred = "true";
  }
}

function syncRootBatteryAttribute() {
  if (batteryTrackingCount === 0 || typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  if (onBatteryPower) {
    root.dataset.onBattery = "true";
  } else {
    delete root.dataset.onBattery;
  }
}

function updateAnimation(animation: ObservedAnimation) {
  const running = animation.intersecting && isWindowActive() && !reducedMotion?.matches;
  animation.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  animation.element.style.setProperty(
    "--visible-animation-will-change",
    running ? "transform" : "auto",
  );
}

function updateAnimations() {
  syncRootBlurredAttribute();
  for (const animation of animations.values()) updateAnimation(animation);
}

function attachLifecycleListeners() {
  if (unsubscribeDocumentActivity !== null || typeof document === "undefined") {
    return;
  }
  unsubscribeDocumentActivity = subscribeDocumentActivity(updateAnimations);
}

function maybeDetachLifecycleListeners() {
  if (unsubscribeDocumentActivity === null || rootTrackingCount > 0 || animations.size > 0) return;
  unsubscribeDocumentActivity();
  unsubscribeDocumentActivity = null;
}

/**
 * Maintains `data-window-blurred="true"` on the root element while the window is
 * unfocused or hidden so CSS can pause infinite animations and backdrop blurs.
 */
export function startWindowBlurTracking(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  rootTrackingCount += 1;
  attachLifecycleListeners();
  syncRootBlurredAttribute();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    rootTrackingCount -= 1;
    if (rootTrackingCount === 0) {
      delete document.documentElement?.dataset.windowBlurred;
    }
    maybeDetachLifecycleListeners();
  };
}

/**
 * Maintains `data-on-battery="true"` on the root element while the desktop host is on battery power
 * so CSS can disable glass blur and pause cosmetic infinite animations without polling IPC.
 */
export function startBatteryPowerTracking(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  batteryTrackingCount += 1;
  if (batteryTrackingCount === 1) {
    const bridge = window.desktopBridge;
    onBatteryPower = bridge?.getOnBatteryPower?.() === true;
    unsubscribePowerState =
      bridge?.onPowerStateChanged?.((nextOnBattery) => {
        onBatteryPower = nextOnBattery;
        syncRootBatteryAttribute();
      }) ?? null;
  }
  syncRootBatteryAttribute();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    batteryTrackingCount -= 1;
    if (batteryTrackingCount === 0) {
      unsubscribePowerState?.();
      unsubscribePowerState = null;
      onBatteryPower = false;
      delete document.documentElement?.dataset.onBattery;
    }
  };
}

export function observeVisibleAnimation(element: HTMLElement | SVGElement | null) {
  if (element === null) return;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return;

  attachLifecycleListeners();

  if (observer === null) {
    reducedMotion =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    reducedMotion?.addEventListener("change", updateAnimations);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const entry of entries) {
        const animation = animations.get(entry.target);
        if (!animation) continue;
        animation.intersecting = entry.isIntersecting;
        updateAnimation(animation);
      }
    });
  }

  const animation = { element, intersecting: false };
  animations.set(element, animation);
  observer.observe(element);

  return () => {
    if (animations.get(element) !== animation) return;
    animations.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (animations.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotion?.removeEventListener("change", updateAnimations);
      reducedMotion = null;
      maybeDetachLifecycleListeners();
    }
  };
}
