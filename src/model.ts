import {simplifyStrokePoints} from "./simplify";

export const SIDECAR_VERSION = 4 as const;

export type AnnotationTool = "pen" | "highlighter";

export interface StrokePoint {
  /** Coordinates normalized to the PDF page, from 0 to 1. */
  x: number;
  y: number;
  /** Pointer pressure, from 0 to 1. */
  pressure: number;
}

export interface Stroke {
  id: string;
  tool: AnnotationTool;
  color: string;
  /** Opacity from 0 (transparent) to 1 (opaque). */
  opacity: number;
  /** Width as a fraction of the rendered page width. */
  width: number;
  points: StrokePoint[];
}

export interface TextAnnotation {
  id: string;
  /** Top-left position normalized to the PDF page. */
  x: number;
  y: number;
  text: string;
  color: string;
  /** Font size as a fraction of the rendered page width. */
  fontSize: number;
}

export interface PageAnnotations {
  strokes: Stroke[];
  texts: TextAnnotation[];
}

export interface AnnotationDocument {
  version: typeof SIDECAR_VERSION;
  source: string;
  updatedAt: string;
  pages: Record<string, PageAnnotations>;
}

export function sidecarPath(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, "") + ".betterscore.json";
}

export function createAnnotationDocument(source: string): AnnotationDocument {
  return {
    version: SIDECAR_VERSION,
    source,
    updatedAt: new Date(0).toISOString(),
    pages: {}
  };
}

export function parseAnnotationDocument(
  json: string,
  expectedSource: string
): AnnotationDocument {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    (value.version !== 1 &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== SIDECAR_VERSION)
  ) {
    throw new Error("Unsupported BetterScore annotation format");
  }
  if (value.source !== expectedSource || !isRecord(value.pages)) {
    throw new Error("Annotation sidecar does not match this PDF");
  }

  const sourceVersion = value.version;
  const pages: Record<string, PageAnnotations> = {};
  for (const [page, annotations] of Object.entries(value.pages)) {
    if (!isRecord(annotations)) continue;
    const strokes = Array.isArray(annotations.strokes) ? annotations.strokes : [];
    const texts = Array.isArray(annotations.texts) ? annotations.texts : [];
    pages[page] = {
      strokes: strokes
        .map((stroke) => parseStroke(stroke, sourceVersion))
        .filter((stroke): stroke is Stroke => stroke !== null),
      texts: texts
        .map(parseTextAnnotation)
        .filter((text): text is TextAnnotation => text !== null)
    };
  }

  return {
    version: SIDECAR_VERSION,
    source: expectedSource,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    pages
  };
}

export function serializeAnnotationDocument(
  document: AnnotationDocument,
  updatedAt = new Date().toISOString()
): string {
  const pages = Object.fromEntries(
    Object.entries(document.pages).map(([pageNumber, page]) => [
      pageNumber,
      {
        strokes: page.strokes.map((stroke) => ({
          id: stroke.id,
          tool: stroke.tool,
          color: stroke.color,
          opacity: round(stroke.opacity, 3),
          width: round(stroke.width, 5),
          points: simplifyStrokePoints(stroke.points, stroke.tool).map((point) => [
            round(point.x, 5),
            round(point.y, 5),
            round(point.pressure, 3)
          ])
        })),
        texts: page.texts.map((text) => ({
          ...text,
          x: round(text.x, 5),
          y: round(text.y, 5),
          fontSize: round(text.fontSize, 5)
        }))
      }
    ])
  );
  return JSON.stringify({
    version: SIDECAR_VERSION,
    source: document.source,
    updatedAt,
    pages
  });
}

function parseTextAnnotation(value: unknown): TextAnnotation | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    typeof value.text !== "string" ||
    typeof value.color !== "string" ||
    typeof value.fontSize !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    x: Math.max(0, Math.min(1, value.x)),
    y: Math.max(0, Math.min(1, value.y)),
    text: value.text,
    color: value.color,
    fontSize: Math.max(0.008, Math.min(0.1, value.fontSize))
  };
}

function parseStroke(value: unknown, sourceVersion: number): Stroke | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null;
  if (value.tool !== "pen" && value.tool !== "highlighter") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.color !== "string" ||
    typeof value.width !== "number"
  ) {
    return null;
  }
  const points = value.points.map(parseStrokePoint);
  if (points.some((point) => point === null)) return null;

  return {
    id: value.id,
    tool: value.tool,
    color: value.color,
    opacity: value.tool === "highlighter" && sourceVersion === 1
      ? 0.2
      : typeof value.opacity === "number"
        ? Math.max(0, Math.min(1, value.opacity))
        : value.tool === "highlighter"
          ? 0.2
          : 0.92,
    width: value.width,
    points: points.filter((point): point is StrokePoint => point !== null)
  };
}

function parseStrokePoint(value: unknown): StrokePoint | null {
  if (
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    typeof value[2] === "number"
  ) {
    return {x: value[0], y: value[1], pressure: value[2]};
  }
  if (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.pressure === "number"
  ) {
    return {x: value.x, y: value.y, pressure: value.pressure};
  }
  return null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
