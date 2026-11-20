import assert from "node:assert/strict";
import test from "node:test";
import {ThumbnailStrip, calculateThumbnailScale} from "../src/thumbnail-strip";
import type {PdfDocument} from "../src/pdf-types";

test("thumbnail scale fits both width and height without enlarging", () => {
  assert.equal(calculateThumbnailScale(600, 900, 100, 120), 2 / 15);
  assert.equal(calculateThumbnailScale(50, 50, 100, 120), 1);
});

test("a completed thumbnail render releases its PDF page resources", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  let cleanupCalls = 0;
  const pdf: PdfDocument = {
    numPages: 1,
    getPage: async () => ({
      getViewport: ({scale}) => ({width: 600 * scale, height: 900 * scale}),
      render: () => ({promise: Promise.resolve()}),
      cleanup: () => {
        cleanupCalls += 1;
      }
    }),
    destroy: async () => undefined
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {requestAnimationFrame: () => 1}
  });
  Reflect.deleteProperty(globalThis, "IntersectionObserver");
  const container = new FakeElement();
  const strip = new ThumbnailStrip(
    container as unknown as HTMLElement,
    pdf,
    () => undefined
  );

  try {
    strip.activate();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cleanupCalls, 1);
  } finally {
    strip.dispose();
    restoreGlobal("window", originalWindow);
    restoreGlobal("IntersectionObserver", originalObserver);
  }
});

class FakeElement {
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];

  empty(): void {
    this.children.length = 0;
  }

  createEl(tag: string): FakeElement {
    const child = tag === "canvas" ? new FakeCanvas() : new FakeElement();
    this.children.push(child);
    return child;
  }

  createSpan(): FakeElement {
    return this.createEl("span");
  }

  addEventListener(): void {}
  addClass(): void {}
  removeClass(): void {}
  scrollIntoView(): void {}
}

class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;

  getContext(): CanvasRenderingContext2D {
    return {} as CanvasRenderingContext2D;
  }
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
