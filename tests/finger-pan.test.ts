import assert from "node:assert/strict";
import test from "node:test";
import {FingerPan} from "../src/finger-pan";

class TestViewport extends EventTarget {
  scrollTop = 100;
  captured: number | null = null;

  setPointerCapture(id: number): void { this.captured = id; }
  hasPointerCapture(id: number): boolean { return this.captured === id; }
  releasePointerCapture(): void { this.captured = null; }

  pointer(type: string, pointerId: number, clientY: number, pointerType = "touch"): void {
    this.dispatchEvent(Object.assign(new Event(type), {pointerId, clientY, pointerType}));
  }
}

test("only the initiating finger scrolls, even with interleaved Pencil events", () => {
  const viewport = new TestViewport();
  const pan = new FingerPan(viewport as unknown as HTMLElement, () => true);
  viewport.pointer("pointerdown", 10, 200, "pen");
  viewport.pointer("pointermove", 10, 160, "pen");
  assert.equal(viewport.scrollTop, 100);
  assert.equal(viewport.captured, null);
  viewport.pointer("pointerdown", 20, 200);
  viewport.pointer("pointermove", 20, 198);
  viewport.pointer("pointerdown", 30, 200);
  viewport.pointer("pointermove", 30, 140);
  viewport.pointer("pointerup", 10, 160, "pen");
  assert.equal(viewport.scrollTop, 100);
  assert.equal(viewport.captured, 20);
  viewport.pointer("pointermove", 20, 170);
  viewport.pointer("pointermove", 20, 175);
  assert.equal(viewport.scrollTop, 125);
  viewport.pointer("pointerup", 20, 175);
  assert.equal(viewport.captured, null);
  pan.dispose();
});

test("pan stops on capture loss and stays disabled for finger drawing or paged mode", () => {
  const viewport = new TestViewport();
  let enabled = false;
  const pan = new FingerPan(viewport as unknown as HTMLElement, () => enabled);
  viewport.pointer("pointerdown", 20, 200);
  viewport.pointer("pointermove", 20, 150);
  assert.equal(viewport.scrollTop, 100);
  assert.equal(viewport.captured, null);
  enabled = true;
  viewport.pointer("pointerdown", 21, 200);
  viewport.pointer("lostpointercapture", 21, 200);
  viewport.pointer("pointermove", 21, 150);
  assert.equal(viewport.scrollTop, 100);
  viewport.pointer("pointerdown", 22, 200);
  viewport.pointer("pointercancel", 22, 200);
  assert.equal(viewport.captured, null);
  pan.dispose();
  viewport.pointer("pointerdown", 23, 200);
  assert.equal(viewport.captured, null);
});
