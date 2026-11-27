import assert from "node:assert/strict";
import {test} from "node:test";
import {PerformanceWakeLock} from "../src/performance-wake-lock";

function sentinel() {
  return {released: false, async release() { this.released = true; }};
}

test("deduplicates acquisition and releases the lock on exit", async () => {
  const lock = sentinel();
  let requests = 0;
  const controller = new PerformanceWakeLock(async () => { requests++; return lock; });
  controller.setWanted(true);
  controller.setWanted(true);
  await Promise.resolve();
  controller.setWanted(true);
  assert.equal(requests, 1);
  controller.setWanted(false);
  assert.equal(lock.released, true);
});

test("releases a pending lock that arrives after exiting", async () => {
  const lock = sentinel();
  let grant!: (value: typeof lock) => void;
  const controller = new PerformanceWakeLock(() => new Promise((resolve) => { grant = resolve; }));
  controller.setWanted(true);
  controller.setWanted(false);
  grant(lock);
  await Promise.resolve();
  assert.equal(lock.released, true);
});

test("a denied request is non-fatal and can be retried on return", async () => {
  const lock = sentinel();
  let requests = 0;
  const controller = new PerformanceWakeLock(async () => {
    if (++requests === 1) throw new Error("NotAllowedError");
    return lock;
  });
  controller.setWanted(true);
  await Promise.resolve();
  controller.setWanted(false);
  controller.setWanted(true);
  await Promise.resolve();
  assert.equal(requests, 2);
  controller.setWanted(false);
  assert.equal(lock.released, true);
});
