import assert from "node:assert/strict";
import test from "node:test";
import {PDFDocument} from "pdf-lib";
import {createAnnotationDocument} from "../src/model";
import {createFlattenedPdf, flattenedPdfPath} from "../src/pdf-export";

test("flattened exports use a non-destructive sibling path", () => {
  assert.equal(flattenedPdfPath("Scores/Requiem.pdf"), "Scores/Requiem.annotated.pdf");
  assert.equal(flattenedPdfPath("Score.PDF", 2), "Score.annotated 2.pdf");
  assert.equal(flattenedPdfPath("Score"), "Score.annotated.pdf");
});

test("flattened export preserves unannotated source pages", async () => {
  const source = await PDFDocument.create();
  source.addPage([600, 800]);
  const sourceBytes = await source.save();
  const annotations = createAnnotationDocument({
    path: "Score.pdf",
    fingerprint: "sha256-partial:test",
    size: sourceBytes.length
  });
  const exported = await createFlattenedPdf(Uint8Array.from(sourceBytes).buffer, annotations);
  const parsed = await PDFDocument.load(exported);
  assert.equal(parsed.getPageCount(), 1);
  assert.deepEqual(parsed.getPage(0).getSize(), {width: 600, height: 800});
});
