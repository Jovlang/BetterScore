const RELEASE_WINDOW_MS = 80;
const DECAY_MS = 100;
const MIN_SPEED = 0.05;
const MAX_SPEED = 1.8;

/** Scroll the viewport without letting the browser pan a Pencil contact. */
export class FingerPan {
  private gesture: {
    pointerId: number; lastX: number; lastY: number; lastTime: number;
    dragging: boolean; vx: number; vy: number;
  } | null = null;
  private frame: number | null = null;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly enabled: () => boolean,
    private readonly canCoast: () => boolean = () => true,
    private readonly frames: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> | null =
      viewport.ownerDocument?.defaultView ?? null
  ) {
    viewport.addEventListener("pointerdown", this.stopCoast, true);
    viewport.addEventListener("pointerdown", this.down);
    viewport.addEventListener("wheel", this.stopCoast, {passive: true});
    viewport.addEventListener("pointermove", this.move);
    viewport.addEventListener("pointerup", this.end);
    viewport.addEventListener("pointercancel", this.end);
    viewport.addEventListener("lostpointercapture", this.end);
  }

  reset(): void {
    this.stopCoast();
    const gesture = this.gesture;
    this.gesture = null;
    if (gesture && this.viewport.hasPointerCapture(gesture.pointerId)) {
      this.viewport.releasePointerCapture(gesture.pointerId);
    }
  }

  dispose(): void {
    this.reset();
    this.viewport.removeEventListener("pointerdown", this.stopCoast, true);
    this.viewport.removeEventListener("pointerdown", this.down);
    this.viewport.removeEventListener("wheel", this.stopCoast);
    this.viewport.removeEventListener("pointermove", this.move);
    this.viewport.removeEventListener("pointerup", this.end);
    this.viewport.removeEventListener("pointercancel", this.end);
    this.viewport.removeEventListener("lostpointercapture", this.end);
  }

  private readonly down = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" || this.gesture || !this.enabled()) return;
    this.viewport.setPointerCapture(event.pointerId);
    this.gesture = {
      pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY,
      lastTime: event.timeStamp, dragging: false, vx: 0, vy: 0
    };
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
    const dt = Math.max(1, event.timeStamp - gesture.lastTime);
    gesture.lastTime = event.timeStamp;
    const speed = Math.hypot(dx, dy) / dt;
    const scale = speed > MAX_SPEED ? MAX_SPEED / speed : 1;
    gesture.vx = dx / dt * scale;
    gesture.vy = dy / dt * scale;
    this.viewport.scrollLeft += dx;
    this.viewport.scrollTop += dy;
  };

  private readonly end = (event: PointerEvent): void => {
    // Taking capture from the touched canvas can send a bubbling loss event
    // from that canvas. Only a loss on the viewport ends its own gesture.
    if (event.type === "lostpointercapture" && event.target !== this.viewport) return;
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.reset();
    if (event.type === "pointerup" && gesture.dragging && this.enabled()) {
      const idle = Math.max(0, event.timeStamp - gesture.lastTime);
      const freshness = Math.max(0, 1 - idle / RELEASE_WINDOW_MS);
      this.coast(gesture.vx * freshness, gesture.vy * freshness, event.timeStamp);
    }
  };

  private readonly stopCoast = (): void => {
    if (this.frame !== null) this.frames?.cancelAnimationFrame(this.frame);
    this.frame = null;
  };

  private coast(vx: number, vy: number, lastTime: number): void {
    const frames = this.frames;
    if (!frames || !this.canCoast() || Math.hypot(vx, vy) < MIN_SPEED) return;
    const viewport = this.viewport;
    let x = viewport.scrollLeft;
    let y = viewport.scrollTop;
    const step = (time: number): void => {
      this.frame = null;
      if (!this.enabled() || !this.canCoast() || time - lastTime > RELEASE_WINDOW_MS) return;
      const dt = Math.max(0, time - lastTime);
      lastTime = Math.max(time, lastTime);
      const decay = Math.exp(-dt / DECAY_MS);
      const distance = DECAY_MS * (1 - decay);
      if (vx) {
        const max = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
        x = Math.min(max, Math.max(0, x + vx * distance));
        viewport.scrollLeft = x;
        vx = (vx > 0 ? x >= max : x <= 0) ? 0 : vx * decay;
      }
      if (vy) {
        const max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        y = Math.min(max, Math.max(0, y + vy * distance));
        viewport.scrollTop = y;
        vy = (vy > 0 ? y >= max : y <= 0) ? 0 : vy * decay;
      }
      if (Math.hypot(vx, vy) >= MIN_SPEED) this.frame = frames.requestAnimationFrame(step);
    };
    this.frame = frames.requestAnimationFrame(step);
  }
}
