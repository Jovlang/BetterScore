import type {ViewMode} from "./viewer-layout";

export type PointerInputIntent = "annotation" | "scroll" | "page-navigation";
export type PageNavigationAction = "next" | "previous" | null;

export interface PageNavigationGesture {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  surfaceLeft: number;
  surfaceWidth: number;
  durationMs: number;
}

/** Keep device policy out of annotation and navigation handlers. */
export function routePointerInput(
  pointerType: string,
  viewMode: ViewMode,
  fingerDrawingEnabled = false
): PointerInputIntent {
  if (pointerType !== "touch") return "annotation";
  if (fingerDrawingEnabled) return "annotation";
  return viewMode === "continuous" ? "scroll" : "page-navigation";
}

export function pageNavigationAction(gesture: PageNavigationGesture): PageNavigationAction {
  const deltaX = gesture.endX - gesture.startX;
  const deltaY = gesture.endY - gesture.startY;
  const swipeThreshold = Math.max(40, gesture.surfaceWidth * 0.08);
  if (Math.abs(deltaX) >= swipeThreshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
    return deltaX < 0 ? "next" : "previous";
  }

  const isTap = gesture.durationMs < 500 && Math.hypot(deltaX, deltaY) < 14;
  if (!isTap || gesture.surfaceWidth <= 0) return null;
  const position = (gesture.endX - gesture.surfaceLeft) / gesture.surfaceWidth;
  if (position < 0.3) return "previous";
  if (position > 0.7) return "next";
  return null;
}
