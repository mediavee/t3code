interface ObservedAnimation {
  element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const animations = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotion: MediaQueryList | null = null;
let windowFocused = true;
let rootTrackingCount = 0;
let lifecycleAttached = false;

function readWindowFocused(): boolean {
  return typeof document !== "undefined" && typeof document.hasFocus === "function"
    ? document.hasFocus()
    : true;
}

function isWindowActive(): boolean {
  return (
    typeof document === "undefined" || (document.visibilityState === "visible" && windowFocused)
  );
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

function handleWindowFocus() {
  windowFocused = true;
  updateAnimations();
}

function handleWindowBlur() {
  windowFocused =
    typeof document !== "undefined" && typeof document.hasFocus === "function"
      ? document.hasFocus()
      : false;
  updateAnimations();
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible") {
    windowFocused = readWindowFocused();
  }
  updateAnimations();
}

function attachLifecycleListeners() {
  if (lifecycleAttached || typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  lifecycleAttached = true;
  windowFocused = readWindowFocused();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
}

function maybeDetachLifecycleListeners() {
  if (!lifecycleAttached || rootTrackingCount > 0 || animations.size > 0) return;
  lifecycleAttached = false;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("blur", handleWindowBlur);
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
