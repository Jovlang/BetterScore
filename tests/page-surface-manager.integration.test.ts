import assert from "node:assert/strict";
import test from "node:test";
import {PageSurfaceManager} from "../src/page-surface-manager";
import type {PdfDocument, PdfPage} from "../src/pdf-types";

test("continuous cold-open only requests the active page before becoming ready", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const requestedPages: number[] = [];
  const fakePage: PdfPage = {
    getViewport: ({scale}) => ({width: 600 * scale, height: 900 * scale}),
    render: () => ({promise: Promise.resolve()}),
    cleanup: () => undefined
  };
  let resolveMountPage: ((page: PdfPage) => void) | undefined;
  const mountPage = new Promise<PdfPage>((resolve) => {
    resolveMountPage = resolve;
  });
  const pdf: PdfDocument = {
    numPages: 300,
    getPage: async (pageNumber) => {
      requestedPages.push(pageNumber);
      return requestedPages.length === 1 ? fakePage : mountPage;
    },
    destroy: async () => undefined
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      devicePixelRatio: 2,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => undefined
    }
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: FakeIntersectionObserver
  });

  const container = new FakeElement(1024, 768);
  FakeElement.boundingRectReads = 0;
  const manager = new PageSurfaceManager(
    container as unknown as HTMLElement,
    pdf,
    {
      onPointerDown: () => undefined,
      onPointerMove: () => undefined,
      onPointerEnd: () => undefined,
      drawAnnotations: () => undefined
    }
  );

  try {
    await manager.setLayout({viewMode: "continuous", currentPage: 137, spreadOffset: 0});
    assert.deepEqual([...new Set(requestedPages)], [137]);
    assert.ok(requestedPages.length <= 2);
    assert.equal(manager.getStats().cachedGeometries, 1);
    assert.equal(manager.getStats().estimatedSlots, 299);
    assert.ok(FakeElement.boundingRectReads < 10);
  } finally {
    manager.dispose();
    resolveMountPage?.(fakePage);
    await Promise.resolve();
    restoreGlobal("window", originalWindow);
    restoreGlobal("IntersectionObserver", originalObserver);
  }
});

for (const viewMode of ["continuous", "single", "spread"] as const) {
  test(`${viewMode} zoom keeps the page and ink mounted until the latest PDF bitmap is ready`, async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        devicePixelRatio: 1,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => undefined
      }
    });
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: FakeIntersectionObserver
    });

    let defer = false;
    const pending: (() => void)[] = [];
    const page: PdfPage = {
      getViewport: ({scale}) => ({width: 600 * scale, height: 900 * scale}),
      render: () => ({promise: new Promise<void>((resolve) => {
        if (defer) pending.push(resolve);
        else resolve();
      })})
    };
    const container = new FakeElement(1024, 768);
    let annotationDraws = 0;
    const manager = new PageSurfaceManager(
      container as unknown as HTMLElement,
      {numPages: viewMode === "spread" ? 2 : 1, getPage: async () => page, destroy: async () => {}},
      {
        onPointerDown: () => {},
        onPointerMove: () => {},
        onPointerEnd: () => {},
        drawAnnotations: (surface) => {
          if (surface.pageNumber === 1) annotationDraws++;
        }
      }
    );
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await manager.setLayout({viewMode, currentPage: 1, spreadOffset: 1});
      await flush();
      const slot = container.children.find((child) => child.dataset.page === "1")!;
      const [bitmap, ink] = slot.children;
      assert.ok(bitmap && ink);
      const originalWidth = bitmap.width;
      assert.ok(originalWidth > 0);
      defer = true;

      // Exercise the same anchored handoff that runs on finger release.
      const pinch = manager.startPinch({x: 100, y: 100}, (zoom, anchor) => {
        void manager.setZoom(zoom, anchor);
      });
      assert.ok(pinch);
      pinch.preview(1.5);
      pinch.finish(1.5);
      await flush();
      assert.equal(pending.length, viewMode === "spread" ? 2 : 1);
      assert.equal(slot.children[0], bitmap);
      assert.equal(bitmap.width, originalWidth);
      assert.equal(slot.children[1], ink);
      assert.equal(annotationDraws, 2);

      await manager.setZoom(2);
      for (const resolve of pending.splice(0)) resolve();
      await flush();
      assert.equal(slot.children[0], bitmap, "an obsolete render must not replace the displayed bitmap");
      assert.equal(pending.length, viewMode === "spread" ? 2 : 1);
      for (const resolve of pending.splice(0)) resolve();
      await flush();
      const [replacement] = slot.children;
      assert.ok(replacement);
      assert.notEqual(replacement, bitmap);
      assert.ok(Math.abs(replacement.width - originalWidth * 2) <= 1);
      assert.equal(bitmap.width, 0, "the superseded bitmap must release its backing store");
      assert.equal(slot.children[1], ink);
      assert.equal(manager.getCurrentPage(), 1);
    } finally {
      manager.dispose();
      defer = false;
      for (const resolve of pending) resolve();
      await flush();
      restoreGlobal("window", originalWindow);
      restoreGlobal("IntersectionObserver", originalObserver);
    }
  });
}

class FakeIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
}

class FakeElement {
  static boundingRectReads = 0;
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classes = new Set<string>();
  scrollTop = 0;
  scrollLeft = 0;
  width = 0;
  height = 0;
  readonly ownerDocument = {createElement: () => new FakeElement()};

  getContext() { return {scale: () => undefined}; }

  createEl(): FakeElement { return this.createDiv(); }

  appendChild(child: FakeElement): void {
    child.remove();
    child.parent = this;
    this.children.push(child);
  }

  replaceWith(next: FakeElement): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    this.parent.children[index] = next;
    next.parent = this.parent;
    this.parent = null;
  }

  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index !== -1) this.parent.children.splice(index, 1);
    this.parent = null;
  }
  parent: FakeElement | null = null;

  constructor(readonly clientWidth = 0, readonly clientHeight = 0) {}

  createDiv(options?: {cls?: string}): FakeElement {
    const child = new FakeElement();
    child.parent = this;
    for (const name of options?.cls?.split(" ") ?? []) child.classes.add(name);
    this.children.push(child);
    return child;
  }

  empty(): void {
    this.children.length = 0;
  }

  addClass(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  removeClass(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggleClass(name: string, enabled: boolean): void {
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  scrollTo(options: {top?: number}): void {
    this.scrollTop = options.top ?? this.scrollTop;
  }

  getBoundingClientRect(): DOMRect {
    FakeElement.boundingRectReads += 1;
    const width = Number.parseFloat(this.style.width ?? "") || this.clientWidth;
    const height = Number.parseFloat(this.style.height ?? "") || this.clientHeight;
    const index = this.parent?.children.indexOf(this) ?? 0;
    const top = this.parent
      ? this.parent.children.slice(0, index).reduce((sum, child) => {
        return sum + (Number.parseFloat(child.style.height ?? "") || child.clientHeight);
      }, -this.parent.scrollTop)
      : 0;
    return {
      x: 0,
      y: top,
      width,
      height,
      top,
      right: width,
      bottom: top + height,
      left: 0,
      toJSON: () => ({})
    };
  }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
