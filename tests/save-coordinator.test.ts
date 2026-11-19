import assert from "node:assert/strict";
import test from "node:test";
import {SaveCoordinator} from "../src/save-coordinator";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("writes never overlap and a change during a write is saved next", async () => {
  const writes: Deferred[] = [];
  let activeWrites = 0;
  let maximumActiveWrites = 0;
  const coordinator = new SaveCoordinator(async () => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    const write = deferred();
    writes.push(write);
    await write.promise;
    activeWrites -= 1;
  });

  coordinator.schedule();
  const flushing = coordinator.flush();
  await nextTurn();
  assert.equal(writes.length, 1);

  coordinator.schedule();
  await nextTurn();
  assert.equal(writes.length, 1, "second write must wait for the first");
  writes[0]?.resolve();
  await nextTurn();
  assert.equal(writes.length, 2, "new revision must trigger a following write");
  writes[1]?.resolve();
  await flushing;

  assert.equal(maximumActiveWrites, 1);
});

test("rapid requests inside the debounce window coalesce", async () => {
  let writes = 0;
  const coordinator = new SaveCoordinator(async () => {
    writes += 1;
  }, 10);
  coordinator.schedule();
  coordinator.schedule();
  coordinator.schedule();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  await coordinator.flush();
  assert.equal(writes, 1);
});

test("flush waits for an in-flight write", async () => {
  const write = deferred();
  let finished = false;
  const coordinator = new SaveCoordinator(async () => write.promise);
  coordinator.schedule();
  const flushing = coordinator.flush().then(() => {
    finished = true;
  });
  await nextTurn();
  assert.equal(finished, false);
  write.resolve();
  await flushing;
  assert.equal(finished, true);
});

test("dispose flushes pending data and ignores later requests", async () => {
  let writes = 0;
  const coordinator = new SaveCoordinator(async () => {
    writes += 1;
  });
  coordinator.schedule();
  await coordinator.dispose();
  coordinator.schedule();
  await coordinator.flush();
  assert.equal(writes, 1);
});

test("a failed write remains pending and can be retried", async () => {
  let attempts = 0;
  const coordinator = new SaveCoordinator(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("disk unavailable");
  });
  coordinator.schedule();
  await assert.rejects(coordinator.flush(), /disk unavailable/);
  await coordinator.flush();
  assert.equal(attempts, 2);
});

test("each queued revision retains its prepared payload", async () => {
  const firstWrite = deferred();
  const saved: number[] = [];
  const coordinator = new SaveCoordinator<number>(async (payload) => {
    saved.push(payload);
    if (payload === 1) await firstWrite.promise;
  });
  coordinator.schedule(1);
  const flushing = coordinator.flush();
  await nextTurn();
  coordinator.schedule(2);
  firstWrite.resolve();
  await flushing;
  assert.deepEqual(saved, [1, 2]);
});

test("a failed prepared payload is not replaced by a newer file", async () => {
  const saved: string[] = [];
  let failOldFile = true;
  const coordinator = new SaveCoordinator<string>(async (payload) => {
    if (payload === "old-file" && failOldFile) {
      failOldFile = false;
      throw new Error("temporary failure");
    }
    saved.push(payload);
  });
  coordinator.schedule("old-file");
  await assert.rejects(coordinator.flush(), /temporary failure/);
  coordinator.schedule("new-file");
  await coordinator.flush();
  assert.deepEqual(saved, ["old-file", "new-file"]);
});
