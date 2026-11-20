import assert from "node:assert/strict";
import test from "node:test";
import {NavigationChange, NavigationController} from "../src/navigation-controller";
import {pagesForLayout, spreadPages} from "../src/viewer-layout";

test("navigation clamps pages and identifies viewport changes", () => {
  const changes: NavigationChange[] = [];
  const navigation = new NavigationController(10, (change) => changes.push(change));
  navigation.goToPage(99);
  navigation.syncViewportPage(4);
  assert.deepEqual(changes.map((change) => [change.state.currentPage, change.cause]), [
    [10, "command"],
    [4, "viewport"]
  ]);
});

test("changing mode preserves the current page", () => {
  const navigation = new NavigationController(20, () => undefined);
  navigation.goToPage(12);
  navigation.setViewMode("single");
  navigation.setViewMode("spread");
  assert.equal(navigation.getState().currentPage, 12);
});

test("spread pairing supports book and corrected offsets", () => {
  assert.deepEqual(spreadPages(1, 8, 0), [1]);
  assert.deepEqual(spreadPages(2, 8, 0), [2, 3]);
  assert.deepEqual(spreadPages(3, 8, 0), [2, 3]);
  assert.deepEqual(spreadPages(1, 8, 1), [1, 2]);
  assert.deepEqual(spreadPages(2, 8, 1), [1, 2]);
  assert.deepEqual(spreadPages(8, 8, 1), [7, 8]);
});

test("mode-aware next and previous use spread boundaries", () => {
  const navigation = new NavigationController(8, () => undefined);
  navigation.setViewMode("spread");
  navigation.next();
  assert.equal(navigation.getState().currentPage, 2);
  navigation.next();
  assert.equal(navigation.getState().currentPage, 4);
  navigation.previous();
  assert.equal(navigation.getState().currentPage, 2);
  navigation.previous();
  assert.equal(navigation.getState().currentPage, 1);
});

test("layout calculation uses one shared viewer state", () => {
  assert.deepEqual(
    pagesForLayout({viewMode: "single", currentPage: 4, spreadOffset: 0}, 10),
    [4]
  );
  assert.deepEqual(
    pagesForLayout({viewMode: "spread", currentPage: 4, spreadOffset: 0}, 10),
    [4, 5]
  );
  assert.equal(
    pagesForLayout({viewMode: "continuous", currentPage: 4, spreadOffset: 0}, 10).length,
    10
  );
});
