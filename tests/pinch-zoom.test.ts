import assert from "node:assert/strict";
import test from "node:test";
import {PinchZoom} from "../src/pinch-zoom";

class TestViewport extends EventTarget {
  readonly captured = new Set<number>();
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }

  pointer(type: string, id: number, x: number, pointerType = "touch", target: EventTarget = this): boolean {
    const event = Object.assign(new Event(type, {cancelable: true}), {
      pointerId: id, clientX: x, clientY: 80, pointerType
    });
    Object.defineProperty(event, "target", {value: target});
    const passed = this.dispatchEvent(event);
    if (type === "pointerup" || type === "pointercancel") this.captured.delete(id);
    return passed;
  }
}

function setup(enabled = true) {
  const viewport = new TestViewport();
  const starts: {x: number; y: number}[] = [];
  const preview: number[] = [];
  const finished: (number | null)[] = [];
  const pinch = new PinchZoom(viewport as unknown as HTMLElement, (point) => {
    if (!enabled) return null;
    starts.push(point);
    return {preview: (scale) => preview.push(scale), finish: (scale) => finished.push(scale)};
  });
  return {viewport, pinch, starts, preview, finished};
}

test("two fingers take over from one-finger input and commit once at the last scale", () => {
  const {viewport, pinch, starts, preview, finished} = setup();
  assert.equal(viewport.pointer("pointerdown", 1, 50), true);
  // FingerPan taking capture from the canvas must not drop the first contact.
  viewport.pointer("lostpointercapture", 1, 50, "touch", new TestViewport());
  assert.equal(viewport.pointer("pointerdown", 2, 150), false);
  assert.deepEqual(starts, [{x: 100, y: 80}]);
  assert.deepEqual([...viewport.captured], [1, 2]);
  viewport.pointer("lostpointercapture", 2, 150, "touch", new TestViewport());
  viewport.pointer("pointermove", 2, 200);
  viewport.pointer("pointermove", 1, 100);
  viewport.pointer("pointermove", 2, 180);
  assert.deepEqual(preview, [1.5, 1, 0.8]);
  assert.deepEqual(finished, []);
  assert.equal(viewport.pointer("pointerup", 1, 0), false);
  assert.equal(viewport.pointer("pointerup", 2, 0), false);
  assert.deepEqual(finished, [0.8]);
  assert.equal(viewport.pointer("pointerdown", 3, 50), true);
  pinch.dispose();
});

test("cancel and Pencil down clear the preview without committing", () => {
  const {viewport, pinch, finished} = setup();
  const start = () => {
    viewport.pointer("pointerdown", 1, 50);
    viewport.pointer("pointerdown", 2, 150);
    viewport.pointer("pointermove", 2, 170);
  };
  start();
  viewport.pointer("pointercancel", 1, 50);
  assert.equal(viewport.pointer("pointerup", 2, 170), false);
  start();
  assert.equal(viewport.pointer("pointerdown", 9, 40, "pen"), true);
  assert.equal(viewport.pointer("pointerup", 1, 50), false);
  assert.equal(viewport.pointer("pointerup", 2, 170), false);
  assert.deepEqual(finished, [null, null]);
  pinch.dispose();
});

test("a Pencil contact never counts as a finger, and finger drawing can decline pinch", () => {
  const {viewport, pinch, starts} = setup();
  viewport.pointer("pointerdown", 1, 50, "pen");
  viewport.pointer("pointerdown", 2, 180);
  assert.deepEqual(starts, []);
  pinch.dispose();
  const disabled = setup(false);
  disabled.viewport.pointer("pointerdown", 1, 50);
  assert.equal(disabled.viewport.pointer("pointerdown", 2, 150), true);
  assert.equal(disabled.viewport.captured.size, 0);
  disabled.pinch.dispose();
});
