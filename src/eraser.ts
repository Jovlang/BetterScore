import {Stroke, StrokePoint} from "./model";

export interface EraseResult {
  strokes: Stroke[];
  changed: boolean;
}

/** Test the visible polyline, not only its stored/simplified sample points. */
export function strokeIntersectsEraser(
  stroke: Stroke,
  center: StrokePoint,
  radius: number
): boolean {
  const first = stroke.points[0];
  if (!first) return false;
  const effectiveRadius = radius + stroke.width / 2;
  if (stroke.points.length === 1) return distance(first, center) <= effectiveRadius;

  for (let index = 1; index < stroke.points.length; index += 1) {
    const start = stroke.points[index - 1];
    const end = stroke.points[index];
    if (start && end && pointToSegmentDistance(center, start, end) <= effectiveRadius) {
      return true;
    }
  }
  return false;
}

/** Remove only the portion of each stroke covered by a circular eraser. */
export function precisionErase(
  strokes: Stroke[],
  center: StrokePoint,
  radius: number
): EraseResult {
  let changed = false;
  const result: Stroke[] = [];

  for (const stroke of strokes) {
    const parts = eraseStrokePart(stroke, center, radius);
    if (parts === null) {
      result.push(stroke);
    } else {
      changed = true;
      result.push(...parts);
    }
  }
  return {strokes: result, changed};
}

function eraseStrokePart(
  stroke: Stroke,
  center: StrokePoint,
  radius: number
): Stroke[] | null {
  if (stroke.points.length === 0) return null;
  const points = densify(stroke.points, Math.max(radius / 2, 0.002));
  if (!points.some((point) => distance(point, center) < radius)) return null;

  const runs: StrokePoint[][] = [];
  let current: StrokePoint[] = [];
  for (const point of points) {
    if (distance(point, center) < radius) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 0) runs.push(current);

  return runs.map((pointsForPart, index) => ({
    ...stroke,
    id: index === 0 ? stroke.id : `${stroke.id}-part-${index}`,
    points: pointsForPart
  }));
}

function densify(points: StrokePoint[], maximumStep: number): StrokePoint[] {
  const first = points[0];
  if (!first) return [];
  const result = [first];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const steps = Math.min(100, Math.max(1, Math.ceil(distance(previous, current) / maximumStep)));
    for (let step = 1; step <= steps; step += 1) {
      const progress = step / steps;
      result.push({
        x: previous.x + (current.x - previous.x) * progress,
        y: previous.y + (current.y - previous.y) * progress,
        pressure: previous.pressure + (current.pressure - previous.pressure) * progress
      });
    }
  }
  return result;
}

function distance(left: StrokePoint, right: StrokePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointToSegmentDistance(
  point: StrokePoint,
  start: StrokePoint,
  end: StrokePoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return distance(point, start);
  const progress = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy))
  );
  return Math.hypot(
    point.x - (start.x + progress * dx),
    point.y - (start.y + progress * dy)
  );
}
