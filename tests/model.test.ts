import assert from "node:assert/strict";
import test from "node:test";
import {
  createAnnotationDocument,
  parseAnnotationDocument,
  sidecarPath
} from "../src/model";

test("sidecarPath keeps annotations beside the score", () => {
  assert.equal(sidecarPath("Scores/Requiem.pdf"), "Scores/Requiem.betterscore.json");
  assert.equal(sidecarPath("Score.PDF"), "Score.betterscore.json");
});

test("annotation documents round-trip", () => {
  const document = createAnnotationDocument("Scores/Requiem.pdf");
  document.pages["1"] = {
    strokes: [
      {
        id: "stroke-1",
        tool: "pen",
        color: "#e53935",
        opacity: 0.92,
        width: 0.0045,
        points: [{x: 0.2, y: 0.3, pressure: 0.5}]
      }
    ],
    texts: [
      {
        id: "text-1",
        x: 0.4,
        y: 0.5,
        text: "Watch the conductor",
        color: "#e53935",
        fontSize: 0.025
      }
    ]
  };
  assert.deepEqual(
    parseAnnotationDocument(JSON.stringify(document), "Scores/Requiem.pdf"),
    document
  );
});

test("strokes without opacity receive a tool-appropriate default", () => {
  const document = createAnnotationDocument("Score.pdf");
  const legacy = {
    ...document,
    pages: {
      "1": {
        strokes: [
          {
            id: "old-highlighter",
            tool: "highlighter",
            color: "#ffd60a",
            width: 0.018,
            points: [{x: 0.1, y: 0.2, pressure: 0.5}]
          }
        ]
      }
    }
  };
  const parsed = parseAnnotationDocument(JSON.stringify(legacy), "Score.pdf");
  assert.equal(parsed.pages["1"]?.strokes[0]?.opacity, 0.2);
  assert.equal(parsed.version, 3);
});

test("version 1 highlighters migrate away from the dark segmented opacity", () => {
  const legacy = {
    version: 1,
    source: "Score.pdf",
    updatedAt: new Date(0).toISOString(),
    pages: {
      "1": {
        strokes: [
          {
            id: "v1-highlighter",
            tool: "highlighter",
            color: "#ffd60a",
            opacity: 0.35,
            width: 0.022,
            points: [
              {x: 0.1, y: 0.2, pressure: 0.5},
              {x: 0.3, y: 0.2, pressure: 0.5}
            ]
          }
        ]
      }
    }
  };
  const parsed = parseAnnotationDocument(JSON.stringify(legacy), "Score.pdf");
  assert.equal(parsed.pages["1"]?.strokes[0]?.opacity, 0.2);
  assert.equal(parsed.version, 3);
});

test("a sidecar cannot silently attach to a different PDF", () => {
  const document = createAnnotationDocument("First.pdf");
  assert.throws(
    () => parseAnnotationDocument(JSON.stringify(document), "Second.pdf"),
    /does not match/
  );
});
