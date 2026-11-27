export interface PinchSession {
  preview: (scale: number) => void;
  finish: (scale: number | null) => void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_START_DISTANCE = 12;
const SCALE_DEAD_ZONE = 0.03;
const EVENTS = [
  "pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"
] as const;
const CAPTURE = {capture: true};

/** Take over two-finger contacts before they reach the pan and page-turn handlers. */
export class PinchZoom {
  private readonly fingers = new Map<number, Point>();
  private readonly captured = new Set<number>();
  private active: {ids: [number, number]; distance: number; session: PinchSession} | null = null;

  constructor(
    private readonly viewport: HTMLElement,
    private readonly start: (point: Point) => PinchSession | null
  ) {
    for (const event of EVENTS) viewport.addEventListener(event, this.handle, CAPTURE);
  }

  get isActive(): boolean { return this.active !== null; }

  reset(): void {
    this.complete(null);
    for (const id of this.captured) {
      if (this.viewport.hasPointerCapture(id)) this.viewport.releasePointerCapture(id);
    }
    this.captured.clear();
    this.fingers.clear();
  }

  dispose(): void {
    this.reset();
    for (const event of EVENTS) this.viewport.removeEventListener(event, this.handle, CAPTURE);
  }

  private readonly handle = (event: PointerEvent): void => {
    if (event.pointerType !== "touch") {
      // Do not start a Pencil stroke against a temporarily scaled overlay.
      if (event.type === "pointerdown") this.complete(null);
      return;
    }
    const id = event.pointerId;
    const point = {x: event.clientX, y: event.clientY};
    if (event.type === "pointerdown") {
      this.fingers.set(id, point);
      if (this.captured.size) this.capture(id);
      else if (this.fingers.size === 2) {
        const first = this.fingers.keys().next().value;
        const second = id;
        if (first === undefined) return;
        const a = this.fingers.get(first)!;
        const b = point;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance >= MIN_START_DISTANCE) {
          const session = this.start({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
          if (session) {
            this.active = {ids: [first, second], distance, session};
            this.capture(first);
            this.capture(second);
          }
        }
      }
    }

    const captured = this.captured.has(id);
    // Transferring capture from a canvas to the viewport emits a loss on the canvas.
    if (event.type === "lostpointercapture" && event.target !== this.viewport) return;
    if (captured) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (event.type === "pointermove" && this.fingers.has(id)) {
      this.fingers.set(id, point);
      if (this.active?.ids.includes(id)) this.active.session.preview(this.scale());
    } else if (event.type !== "pointerdown" && event.type !== "pointermove") {
      if (this.active?.ids.includes(id)) {
        // Use the last move sample; on lift the reported position can jump.
        this.complete(event.type === "pointerup" ? this.scale() : null);
      }
      this.fingers.delete(id);
      this.captured.delete(id);
    }
  };

  private capture(id: number): void {
    this.viewport.setPointerCapture(id);
    this.captured.add(id);
  }

  private scale(): number {
    const {ids, distance} = this.active!;
    const a = this.fingers.get(ids[0])!;
    const b = this.fingers.get(ids[1])!;
    const scale = Math.hypot(a.x - b.x, a.y - b.y) / distance;
    return Math.abs(scale - 1) < SCALE_DEAD_ZONE ? 1 : scale;
  }

  private complete(scale: number | null): void {
    const active = this.active;
    this.active = null;
    active?.session.finish(scale);
  }
}
