import assert from "node:assert/strict";
import test from "node:test";
import {pageNavigationAction, routePointerInput} from "../src/input-router";

test("Pencil and mouse input always route to annotation", () => {
  assert.equal(routePointerInput("pen", "continuous"), "annotation");
  assert.equal(routePointerInput("pen", "spread"), "annotation");
  assert.equal(routePointerInput("mouse", "single"), "annotation");
});

test("finger input scrolls continuous mode and navigates paged modes", () => {
  assert.equal(routePointerInput("touch", "continuous"), "scroll");
  assert.equal(routePointerInput("touch", "single"), "page-navigation");
  assert.equal(routePointerInput("touch", "spread"), "page-navigation");
});

test("horizontal swipes and edge taps map to page navigation", () => {
  const base = {
    startX: 500,
    startY: 300,
    endX: 420,
    endY: 305,
    surfaceLeft: 100,
    surfaceWidth: 800,
    durationMs: 250
  };
  assert.equal(pageNavigationAction(base), "next");
  assert.equal(pageNavigationAction({...base, endX: 580}), "previous");
  assert.equal(pageNavigationAction({...base, startX: 850, endX: 850}), "next");
  assert.equal(pageNavigationAction({...base, startX: 150, endX: 150}), "previous");
  assert.equal(pageNavigationAction({...base, startX: 500, endX: 500}), null);
});

test("vertical, slow edge taps, and ambiguous gestures do not turn pages", () => {
  const base = {
    startX: 500,
    startY: 300,
    endX: 505,
    endY: 380,
    surfaceLeft: 100,
    surfaceWidth: 800,
    durationMs: 250
  };
  assert.equal(pageNavigationAction(base), null);
  assert.equal(pageNavigationAction({
    ...base,
    startX: 850,
    startY: 300,
    endX: 850,
    endY: 300,
    durationMs: 700
  }), null);
  assert.equal(pageNavigationAction({...base, endX: 520, endY: 320}), null);
});
