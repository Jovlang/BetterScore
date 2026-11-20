import type {PageAnnotations, Stroke, TextAnnotation} from "./model";

export function drawPageAnnotations(
  context: CanvasRenderingContext2D,
  annotations: PageAnnotations,
  width: number,
  height: number
): void {
  for (const stroke of annotations.strokes) drawStroke(context, stroke, width, height);
  for (const text of annotations.texts) drawTextAnnotation(context, text, width, height);
}

function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  width: number,
  height: number
): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.globalAlpha = stroke.opacity;
  context.globalCompositeOperation = "source-over";
  context.lineCap = "round";
  context.lineJoin = "round";

  const first = stroke.points[0];
  if (!first) {
    context.restore();
    return;
  }
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x * width, first.y * height, stroke.width * width * 0.5, 0, Math.PI * 2);
    context.fill();
  } else if (stroke.tool === "highlighter") {
    context.lineWidth = stroke.width * width;
    context.beginPath();
    context.moveTo(first.x * width, first.y * height);
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x * width, point.y * height);
    }
    context.stroke();
  } else {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1];
      const point = stroke.points[index];
      if (!previous || !point) continue;
      const pressure = (previous.pressure + point.pressure) / 2;
      context.lineWidth = stroke.width * width * (0.65 + pressure * 0.7);
      context.beginPath();
      context.moveTo(previous.x * width, previous.y * height);
      context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
  context.restore();
}

function drawTextAnnotation(
  context: CanvasRenderingContext2D,
  annotation: TextAnnotation,
  width: number,
  height: number
): void {
  const fontSize = annotation.fontSize * width;
  context.save();
  context.fillStyle = annotation.color;
  context.globalAlpha = 0.95;
  context.font = `600 ${fontSize}px sans-serif`;
  context.textBaseline = "top";
  annotation.text.split("\n").forEach((line, index) => {
    context.fillText(
      line,
      annotation.x * width,
      annotation.y * height + index * fontSize * 1.2
    );
  });
  context.restore();
}
