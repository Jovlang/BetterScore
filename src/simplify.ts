import type {AnnotationTool, StrokePoint} from "./model";

export function shouldRecordSample(previous: StrokePoint, next: StrokePoint): boolean {
  return distance(previous, next) >= 0.00075 || Math.abs(previous.pressure - next.pressure) >= 0.025;
}

export function simplifyStrokePoints(
  points: StrokePoint[],
  tool: AnnotationTool
): StrokePoint[] {
  if (points.length <= 2) return points.slice();
  const minimumDistance = tool === "highlighter" ? 0.001 : 0.0006;
  const tolerance = tool === "highlighter" ? 0.0015 : 0.0008;
  const filtered = filterByMinimumDistance(points, minimumDistance);
  if (filtered.length <= 2) return filtered;

  // Pressure changes affect pen width, so make them hard anchors before
  // simplifying the geometry between each pair of anchors.
  const anchors = [0];
  let anchorPressure = filtered[0]?.pressure ?? 0.5;
  for (let index = 1; index < filtered.length - 1; index += 1) {
    const point = filtered[index];
    if (point && Math.abs(point.pressure - anchorPressure) >= 0.08) {
      anchors.push(index);
      anchorPressure = point.pressure;
    }
  }
  anchors.push(filtered.length - 1);

  const kept = new Set<number>(anchors);
  for (let index = 1; index < anchors.length; index += 1) {
    const start = anchors[index - 1];
    const end = anchors[index];
    if (start !== undefined && end !== undefined) {
      addRamerDouglasPeuckerPoints(filtered, start, end, tolerance, kept);
    }
  }
  return [...kept].sort((left, right) => left - right).map((index) => filtered[index]!).filter(Boolean);
}

function filterByMinimumDistance(points: StrokePoint[], minimumDistance: number): StrokePoint[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  const result = [first];
  let previous = first;
  for (let index = 1; index < points.length - 1; index += 1) {
    const point = points[index];
    if (!point) continue;
    if (
      distance(previous, point) >= minimumDistance ||
      Math.abs(previous.pressure - point.pressure) >= 0.04
    ) {
      result.push(point);
      previous = point;
    }
  }
  if (last !== result[result.length - 1]) result.push(last);
  return result;
}

function addRamerDouglasPeuckerPoints(
  points: StrokePoint[],
  start: number,
  end: number,
  tolerance: number,
  kept: Set<number>
): void {
  const stack: Array<[number, number]> = [[start, end]];
  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) continue;
    const [rangeStart, rangeEnd] = range;
    const first = points[rangeStart];
    const last = points[rangeEnd];
    if (!first || !last || rangeEnd - rangeStart <= 1) continue;

    let furthestIndex = -1;
    let furthestDistance = 0;
    for (let index = rangeStart + 1; index < rangeEnd; index += 1) {
      const point = points[index];
      if (!point) continue;
      const candidateDistance = perpendicularDistance(point, first, last);
      if (candidateDistance > furthestDistance) {
        furthestDistance = candidateDistance;
        furthestIndex = index;
      }
    }
    if (furthestIndex >= 0 && furthestDistance > tolerance) {
      kept.add(furthestIndex);
      stack.push([rangeStart, furthestIndex], [furthestIndex, rangeEnd]);
    }
  }
}

function perpendicularDistance(point: StrokePoint, start: StrokePoint, end: StrokePoint): number {
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

function distance(left: StrokePoint, right: StrokePoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}
