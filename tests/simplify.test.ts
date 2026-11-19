import assert from "node:assert/strict";
import test from "node:test";
import {simplifyStrokePoints} from "../src/simplify";

test("a nearly straight mouse stroke collapses from hundreds of samples", () => {
  const points = Array.from({length: 500}, (_, index) => ({
    x: index / 500,
    y: 0.5 + Math.sin(index / 20) * 0.0001,
    pressure: 0.5
  }));
  const simplified = simplifyStrokePoints(points, "highlighter");
  assert.ok(simplified.length <= 3, `${simplified.length} points remained`);
  assert.deepEqual(simplified[0], points[0]);
  assert.deepEqual(simplified.at(-1), points.at(-1));
});

test("simplification preserves corners and meaningful pressure changes", () => {
  const points = [
    {x: 0, y: 0, pressure: 0.2},
    {x: 0.25, y: 0, pressure: 0.2},
    {x: 0.5, y: 0, pressure: 0.5},
    {x: 0.5, y: 0.25, pressure: 0.5},
    {x: 0.5, y: 0.5, pressure: 0.5}
  ];
  const simplified = simplifyStrokePoints(points, "pen");
  assert.ok(simplified.some((point) => point.x === 0.5 && point.y === 0));
  assert.ok(simplified.some((point) => point.pressure === 0.5));
});
