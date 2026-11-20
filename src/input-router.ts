import type {ViewMode} from "./viewer-layout";

export type PointerInputIntent = "annotation" | "scroll" | "page-navigation";

/** Keep device policy out of annotation and navigation handlers. */
export function routePointerInput(
  pointerType: string,
  viewMode: ViewMode
): PointerInputIntent {
  if (pointerType !== "touch") return "annotation";
  return viewMode === "continuous" ? "scroll" : "page-navigation";
}
