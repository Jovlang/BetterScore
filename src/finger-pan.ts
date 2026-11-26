/** Scroll the viewport without letting the browser pan a Pencil contact. */
export class FingerPan {
  private gesture: {pointerId: number; lastX: number; lastY: number; dragging: boolean} | null = null;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly enabled: () => boolean
  ) {
    viewport.addEventListener("pointerdown", this.down);
    viewport.addEventListener("pointermove", this.move);
    viewport.addEventListener("pointerup", this.end);
    viewport.addEventListener("pointercancel", this.end);
    viewport.addEventListener("lostpointercapture", this.end);
  }

  reset(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture && this.viewport.hasPointerCapture(gesture.pointerId)) {
      this.viewport.releasePointerCapture(gesture.pointerId);
    }
  }

  dispose(): void {
    this.reset();
    this.viewport.removeEventListener("pointerdown", this.down);
    this.viewport.removeEventListener("pointermove", this.move);
    this.viewport.removeEventListener("pointerup", this.end);
    this.viewport.removeEventListener("pointercancel", this.end);
    this.viewport.removeEventListener("lostpointercapture", this.end);
  }

  private readonly down = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" || this.gesture || !this.enabled()) return;
    this.viewport.setPointerCapture(event.pointerId);
    this.gesture = {pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY, dragging: false};
  };

  private readonly move = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!this.enabled()) {
      this.reset();
      return;
    }
    const dx = gesture.lastX - event.clientX;
    const dy = gesture.lastY - event.clientY;
    if (!gesture.dragging && Math.hypot(dx, dy) < 4) return;
    gesture.dragging = true;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    this.viewport.scrollLeft += dx;
    this.viewport.scrollTop += dy;
  };

  private readonly end = (event: PointerEvent): void => {
    // Taking capture from the touched canvas can send a bubbling loss event
    // from that canvas. Only a loss on the viewport ends its own gesture.
    if (event.type === "lostpointercapture" && event.target !== this.viewport) return;
    if (this.gesture?.pointerId === event.pointerId) this.reset();
  };
}
