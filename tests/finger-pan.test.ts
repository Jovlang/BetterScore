import assert from "node:assert/strict";
import test from "node:test";
import {FingerPan} from "../src/finger-pan";

class TestViewport extends EventTarget {
  scrollTop = 100;
  scrollLeft = 100;
  scrollWidth = 1000;
  scrollHeight = 1000;
  clientWidth = 200;
  clientHeight = 200;
  captured: number | null = null;

  setPointerCapture(id: number): void { this.captured = id; }
  hasPointerCapture(id: number): boolean { return this.captured === id; }
  releasePointerCapture(): void { this.captured = null; }

  pointer(type: string, pointerId: number, clientY: number, pointerType = "touch", clientX = 0, timeStamp = 0): void {
    const event = Object.assign(new Event(type), {pointerId, clientX, clientY, pointerType});
    Object.defineProperty(event, "timeStamp", {value: timeStamp});
    this.dispatchEvent(event);
  }
}

function setupCoast(canCoast?: () => boolean) {
  const viewport = new TestViewport();
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  const pan = new FingerPan(viewport as unknown as HTMLElement, () => true, canCoast, {
    requestAnimationFrame: (callback) => { pending.set(++id, callback); return id; },
    cancelAnimationFrame: (id) => { pending.delete(id); }
  });
  return {
    viewport, pan, pending,
    step(time: number) {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback(time);
      }
    },
    drag() {
      viewport.pointer("pointerdown", 1, 200, "touch", 100, 0);
      viewport.pointer("pointermove", 1, 176, "touch", 84, 24);
    }
  };
}

test("a flick coasts on both axes, slows down, and comes to rest", () => {
  const {viewport, pending, step, drag} = setupCoast();
  drag();
  viewport.pointer("pointerup", 1, 176, "touch", 84, 28);
  viewport.pointer("lostpointercapture", 1, 176);
  assert.equal(viewport.captured, null);
  step(44);
  const first = viewport.scrollTop - 124;
  assert.ok(first > 0);
  assert.ok(viewport.scrollLeft > 116);
  const previous = viewport.scrollTop;
  step(60);
  assert.ok(viewport.scrollTop - previous > 0 && viewport.scrollTop - previous < first);
  for (let time = 76; time < 460; time += 16) step(time);
  assert.equal(pending.size, 0);
  assert.ok(viewport.scrollTop < 224);
});

test("a pause, cancelled drag, or active annotation prevents coasting", () => {
  for (const [event, time, canCoast] of [
    ["pointerup", 120, true],
    ["pointercancel", 28, true],
    ["lostpointercapture", 28, true],
    ["pointerup", 28, false]
  ] as const) {
    const {viewport, pending, drag} = setupCoast(() => canCoast);
    drag();
    viewport.pointer(event, 1, 176, "touch", 84, time);
    assert.equal(pending.size, 0);
    assert.equal(viewport.scrollTop, 124);
  }
});

test("coasting stops at the bounds or on new input, reset, or disposal", () => {
  const {viewport, pending, step, drag} = setupCoast();
  viewport.scrollWidth = 320;
  viewport.scrollHeight = 330;
  drag();
  viewport.pointer("pointerup", 1, 176, "touch", 84, 28);
  step(44);
  assert.equal(viewport.scrollLeft, 120);
  assert.equal(viewport.scrollTop, 130);
  assert.equal(pending.size, 0);

  for (const stop of [
    (s: ReturnType<typeof setupCoast>) => s.viewport.pointer("pointerdown", 2, 150),
    (s: ReturnType<typeof setupCoast>) => s.viewport.pointer("pointerdown", 2, 150, "pen"),
    (s: ReturnType<typeof setupCoast>) => s.viewport.dispatchEvent(new Event("wheel")),
    (s: ReturnType<typeof setupCoast>) => s.pan.reset(),
    (s: ReturnType<typeof setupCoast>) => s.pan.dispose()
  ]) {
    const session = setupCoast();
    session.drag();
    session.viewport.pointer("pointerup", 1, 176, "touch", 84, 28);
    assert.equal(session.pending.size, 1);
    stop(session);
    assert.equal(session.pending.size, 0);
    session.step(44);
    assert.equal(session.viewport.scrollTop, 124);
  }
});

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

test("one finger can pan horizontally on a zoomed score", () => {
  const viewport = new TestViewport();
  const pan = new FingerPan(viewport as unknown as HTMLElement, () => true);
  viewport.pointer("pointerdown", 1, 200, "touch", 60);
  viewport.pointer("pointermove", 1, 200, "touch", 30);
  assert.equal(viewport.scrollLeft, 130);
  assert.equal(viewport.scrollTop, 100);
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
