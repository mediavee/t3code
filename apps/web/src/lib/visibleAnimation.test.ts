import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { observeVisibleAnimation, startWindowBlurTracking } from "./visibleAnimation";

function installMockDom(options?: {
  initialFocused?: boolean;
  initialVisibility?: DocumentVisibilityState;
  reducedMotion?: boolean;
}) {
  let focused = options?.initialFocused ?? true;
  let visibilityState: DocumentVisibilityState = options?.initialVisibility ?? "visible";
  let reduced = options?.reducedMotion ?? false;
  const docTarget = new EventTarget();
  const winTarget = new EventTarget();
  const mediaTarget = new EventTarget();
  const rootDataset: Record<string, string | undefined> = {};

  const doc = Object.assign(docTarget, {
    hasFocus: () => focused,
    documentElement: {
      dataset: rootDataset,
    },
  });
  Object.defineProperty(doc, "visibilityState", {
    configurable: true,
    get: () => visibilityState,
  });

  const mediaQueryList = mediaTarget as EventTarget & { readonly matches: boolean };
  Object.defineProperty(mediaQueryList, "matches", {
    configurable: true,
    get: () => reduced,
  });

  const win = Object.assign(winTarget, {
    matchMedia: () => mediaQueryList,
  });

  let observerCallback:
    | ((entries: Array<{ target: Element; isIntersecting: boolean }>, source: unknown) => void)
    | null = null;
  let observerInstance: MockIntersectionObserver | null = null;

  class MockIntersectionObserver {
    observed = new Set<Element>();
    disconnected = false;
    constructor(
      callback: (
        entries: Array<{ target: Element; isIntersecting: boolean }>,
        source: unknown,
      ) => void,
    ) {
      observerCallback = callback;
      observerInstance = this;
    }
    observe(target: Element) {
      this.observed.add(target);
    }
    unobserve(target: Element) {
      this.observed.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.observed.clear();
    }
  }

  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);

  const makeElement = () => {
    const props = new Map<string, string>();
    return {
      style: {
        setProperty: (name: string, value: string) => props.set(name, value),
        getPropertyValue: (name: string) => props.get(name) ?? "",
      },
    } as unknown as HTMLElement;
  };

  return {
    rootDataset,
    makeElement,
    getObserver: () => observerInstance,
    setIntersecting: (target: Element, isIntersecting: boolean) => {
      observerCallback?.([{ target, isIntersecting }], observerInstance);
    },
    blur: () => {
      focused = false;
      winTarget.dispatchEvent(new Event("blur"));
    },
    focus: () => {
      focused = true;
      winTarget.dispatchEvent(new Event("focus"));
    },
    setVisibility: (next: DocumentVisibilityState) => {
      visibilityState = next;
      docTarget.dispatchEvent(new Event("visibilitychange"));
    },
    setReducedMotion: (next: boolean) => {
      reduced = next;
      mediaTarget.dispatchEvent(new Event("change"));
    },
  };
}

describe("visibleAnimation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pauses animations when off-screen, unfocused, hidden, or reduced-motion", () => {
    const dom = installMockDom({ initialFocused: true, initialVisibility: "visible" });
    const element = dom.makeElement();
    const cleanup = observeVisibleAnimation(element);

    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("paused");
    expect(element.style.getPropertyValue("--visible-animation-will-change")).toBe("auto");

    dom.setIntersecting(element, true);
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("running");
    expect(element.style.getPropertyValue("--visible-animation-will-change")).toBe("transform");

    dom.blur();
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("paused");
    expect(element.style.getPropertyValue("--visible-animation-will-change")).toBe("auto");

    dom.focus();
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("running");

    dom.setVisibility("hidden");
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("paused");

    dom.setVisibility("visible");
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("running");

    dom.setReducedMotion(true);
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("paused");

    dom.setReducedMotion(false);
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("running");

    dom.setIntersecting(element, false);
    expect(element.style.getPropertyValue("--visible-animation-state")).toBe("paused");

    cleanup?.();
    expect(dom.getObserver()?.disconnected).toBe(true);
  });

  it("maintains data-window-blurred on the document root across focus and visibility changes", () => {
    const dom = installMockDom({ initialFocused: true, initialVisibility: "visible" });
    const dispose = startWindowBlurTracking();

    expect(dom.rootDataset.windowBlurred).toBeUndefined();

    dom.blur();
    expect(dom.rootDataset.windowBlurred).toBe("true");

    dom.focus();
    expect(dom.rootDataset.windowBlurred).toBeUndefined();

    dom.setVisibility("hidden");
    expect(dom.rootDataset.windowBlurred).toBe("true");

    dom.setVisibility("visible");
    expect(dom.rootDataset.windowBlurred).toBeUndefined();

    dom.blur();
    expect(dom.rootDataset.windowBlurred).toBe("true");

    dispose();
    expect(dom.rootDataset.windowBlurred).toBeUndefined();
  });

  it("starts blurred when document.hasFocus() is initially false and clears on focus", () => {
    const dom = installMockDom({ initialFocused: false, initialVisibility: "visible" });
    const dispose = startWindowBlurTracking();

    expect(dom.rootDataset.windowBlurred).toBe("true");

    dom.focus();
    expect(dom.rootDataset.windowBlurred).toBeUndefined();

    dispose();
  });
});
