import assert from "node:assert/strict";
import test from "node:test";
import {createSourceIdentity} from "../src/source-identity";

function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

test("source identity is stable for identical PDF content", async () => {
  const first = await createSourceIdentity("First.pdf", bytes([1, 2, 3, 4]));
  const second = await createSourceIdentity("Moved.pdf", bytes([1, 2, 3, 4]));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.size, second.size);
  assert.notEqual(first.path, second.path);
});

test("source identity changes when PDF content changes", async () => {
  const first = await createSourceIdentity("Score.pdf", bytes([1, 2, 3, 4]));
  const second = await createSourceIdentity("Score.pdf", bytes([1, 2, 3, 5]));
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("source identity includes file size", async () => {
  const first = await createSourceIdentity("Score.pdf", bytes([1, 2, 3]));
  const second = await createSourceIdentity("Score.pdf", bytes([1, 2, 3, 0]));
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(first.size, 3);
  assert.equal(second.size, 4);
});
