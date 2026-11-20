import assert from "node:assert/strict";
import test from "node:test";
import {routePointerInput} from "../src/input-router";

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
