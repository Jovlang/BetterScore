import assert from "node:assert/strict";
import test from "node:test";
import {NavigationChange, NavigationController} from "../src/navigation-controller";
import {
  nextSpreadAnchor,
  pagesForLayout,
  previousSpreadAnchor,
  spreadForPage
} from "../src/viewer-layout";

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
  assert.deepEqual(spreadForPage(1, 0, 8), [1]);
  assert.deepEqual(spreadForPage(2, 0, 8), [2, 3]);
  assert.deepEqual(spreadForPage(3, 0, 8), [2, 3]);
  assert.deepEqual(spreadForPage(1, 1, 8), [1, 2]);
  assert.deepEqual(spreadForPage(2, 1, 8), [1, 2]);
  assert.deepEqual(spreadForPage(8, 1, 8), [7, 8]);
});

test("spread anchors are pure and clamp at document boundaries", () => {
  assert.equal(nextSpreadAnchor(1, 0, 8), 2);
  assert.equal(nextSpreadAnchor(3, 0, 8), 4);
  assert.equal(nextSpreadAnchor(8, 0, 8), 8);
  assert.equal(previousSpreadAnchor(8, 0, 8), 6);
  assert.equal(previousSpreadAnchor(2, 0, 8), 1);
  assert.equal(previousSpreadAnchor(1, 0, 8), 1);

  assert.equal(nextSpreadAnchor(2, 1, 8), 3);
  assert.equal(previousSpreadAnchor(3, 1, 8), 1);
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

test("currentPage remains the active PDF page when its spread starts earlier", () => {
  const navigation = new NavigationController(10, () => undefined);
  navigation.goToPage(5);
  navigation.setViewMode("spread");
  assert.equal(navigation.getState().currentPage, 5);
  assert.deepEqual(pagesForLayout(navigation.getState(), 10), [4, 5]);
  navigation.setViewMode("single");
  assert.equal(navigation.getState().currentPage, 5);
});

test("spread correction changes pairing without changing the active page", () => {
  const navigation = new NavigationController(10, () => undefined);
  navigation.goToPage(5);
  navigation.setViewMode("spread");
  assert.deepEqual(pagesForLayout(navigation.getState(), 10), [4, 5]);
  navigation.setSpreadOffset(1);
  assert.equal(navigation.getState().currentPage, 5);
  assert.deepEqual(pagesForLayout(navigation.getState(), 10), [5, 6]);
});
