import assert from "node:assert/strict";
import test from "node:test";
import {normalizeWheelDelta, zoomStepsForWheelDelta} from "../src/zoom-input";

test("wheel delta modes normalize to pixels", () => {
  assert.equal(normalizeWheelDelta(10, 0, 800), 10);
  assert.equal(normalizeWheelDelta(3, 1, 800), 48);
  assert.equal(normalizeWheelDelta(1, 2, 800), 800);
});

test("wheel direction maps to bounded zoom steps", () => {
  assert.equal(zoomStepsForWheelDelta(-100), 1);
  assert.equal(zoomStepsForWheelDelta(100), -1);
  assert.equal(zoomStepsForWheelDelta(-310), 3);
  assert.equal(zoomStepsForWheelDelta(1000), -4);
  assert.equal(zoomStepsForWheelDelta(0), 0);
});
