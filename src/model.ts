export const SIDECAR_VERSION = 2 as const;

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

export interface PageAnnotations {
  strokes: Stroke[];
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
  if (!isRecord(value) || (value.version !== 1 && value.version !== SIDECAR_VERSION)) {
    throw new Error("Unsupported BetterScore annotation format");
  }
  if (value.source !== expectedSource || !isRecord(value.pages)) {
    throw new Error("Annotation sidecar does not match this PDF");
  }

  const sourceVersion = value.version;
  const pages: Record<string, PageAnnotations> = {};
  for (const [page, annotations] of Object.entries(value.pages)) {
    if (!isRecord(annotations) || !Array.isArray(annotations.strokes)) continue;
    pages[page] = {
      strokes: annotations.strokes
        .map((stroke) => parseStroke(stroke, sourceVersion))
        .filter((stroke): stroke is Stroke => stroke !== null)
    };
  }

  return {
    version: SIDECAR_VERSION,
    source: expectedSource,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    pages
  };
}

function parseStroke(value: unknown, sourceVersion: number): Stroke | null {
  if (!isRecord(value) || !Array.isArray(value.points)) return null;
  if (value.tool !== "pen" && value.tool !== "highlighter") return null;
  if (
    typeof value.id !== "string" ||
    typeof value.color !== "string" ||
    typeof value.width !== "number" ||
    !value.points.every(isStrokePoint)
  ) {
    return null;
  }

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
    points: value.points
  };
}

function isStrokePoint(value: unknown): value is StrokePoint {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.pressure === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
