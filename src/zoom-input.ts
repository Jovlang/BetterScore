const PIXELS_PER_ZOOM_STEP = 100;
const MAX_STEPS_PER_GESTURE = 4;
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

export function normalizeWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === DELTA_MODE_LINE) return deltaY * 16;
  if (deltaMode === DELTA_MODE_PAGE) return deltaY * Math.max(1, viewportHeight);
  return deltaY;
}

/** Positive means zoom in; negative means zoom out. */
export function zoomStepsForWheelDelta(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const magnitude = Math.min(
    MAX_STEPS_PER_GESTURE,
    Math.max(1, Math.round(Math.abs(delta) / PIXELS_PER_ZOOM_STEP))
  );
  return delta < 0 ? magnitude : -magnitude;
}
