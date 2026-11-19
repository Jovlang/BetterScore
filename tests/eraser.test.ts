import assert from "node:assert/strict";
import test from "node:test";
import {precisionErase, strokeIntersectsEraser} from "../src/eraser";
import {Stroke} from "../src/model";

function horizontalStroke(): Stroke {
  return {
    id: "line",
    tool: "pen",
    color: "#e53935",
    opacity: 0.92,
    width: 0.0045,
    points: [
      {x: 0.1, y: 0.5, pressure: 0.5},
      {x: 0.9, y: 0.5, pressure: 0.5}
    ]
  };
}

test("precision eraser splits a stroke instead of deleting it", () => {
  const result = precisionErase(
    [horizontalStroke()],
    {x: 0.5, y: 0.5, pressure: 0.5},
    0.05
  );
  assert.equal(result.changed, true);
  assert.equal(result.strokes.length, 2);
  assert.ok(result.strokes[0]?.points.every((point) => point.x < 0.5));
  assert.ok(result.strokes[1]?.points.every((point) => point.x > 0.5));
});

test("precision eraser preserves untouched strokes", () => {
  const stroke = horizontalStroke();
  const result = precisionErase([stroke], {x: 0.5, y: 0.8, pressure: 0.5}, 0.02);
  assert.equal(result.changed, false);
  assert.equal(result.strokes[0], stroke);
});

test("stroke eraser hits the middle of a two-point simplified line", () => {
  const stroke = horizontalStroke();
  assert.equal(
    strokeIntersectsEraser(stroke, {x: 0.5, y: 0.5, pressure: 0.5}, 0.01),
    true
  );
});

test("stroke eraser ignores a point away from every line segment", () => {
  const stroke = horizontalStroke();
  assert.equal(
    strokeIntersectsEraser(stroke, {x: 0.5, y: 0.7, pressure: 0.5}, 0.01),
    false
  );
});
