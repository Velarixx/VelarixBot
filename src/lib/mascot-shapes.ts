// Agent icon silhouettes for CursorAvatar. The baked-in cursor arrow is
// the fallback; the rest are distinct filled shapes that stay readable at
// sidebar (~56px) and compact (~24px) sizes. Faces sit via `anchor`.
import { SHAPE, type CursorShape } from "@/components/CursorAvatar";

export const ICON_SHAPE_NAMES = [
  "cursor",
  "blob",
  "circle",
  "squircle",
  "diamond",
  "hexagon",
  "teardrop",
  "shield",
] as const;

export type IconShapeName = (typeof ICON_SHAPE_NAMES)[number];

const CURSOR: CursorShape = {
  ...SHAPE,
  body: SHAPE.body.replace(/fill="#000000"/g, 'fill="{{GRADIENT}}"'),
};

function pair(d: string): Pick<CursorShape, "body" | "clip"> {
  return {
    body: `<path d="${d}" fill="{{GRADIENT}}"/>`,
    clip: `<path d="${d}"/>`,
  };
}

const BLOB = pair(
  "M114 16 C176 16 214 58 214 112 C214 168 176 214 114 214 C52 214 14 168 14 112 C14 58 52 16 114 16 Z",
);
const CIRCLE: Pick<CursorShape, "body" | "clip"> = {
  body: `<circle cx="114" cy="114" r="98" fill="{{GRADIENT}}"/>`,
  clip: `<circle cx="114" cy="114" r="98"/>`,
};
const SQUIRCLE = pair(
  "M46 22 H182 C198 22 206 30 206 46 V182 C206 198 198 206 182 206 H46 C30 206 22 198 22 182 V46 C22 30 30 22 46 22 Z",
);
const DIAMOND = pair("M114 14 L214 114 L114 214 L14 114 Z");
const HEXAGON = pair("M114 16 L201 64 L201 164 L114 212 L27 164 L27 64 Z");
const TEARDROP = pair(
  "M114 12 C176 12 210 70 210 118 C210 166 156 198 114 220 C72 198 18 166 18 118 C18 70 52 12 114 12 Z",
);
const SHIELD = pair(
  "M114 14 L202 46 L202 118 C202 176 160 208 114 222 C68 208 26 176 26 118 L26 46 Z",
);

const SHAPES: Record<IconShapeName, CursorShape> = {
  cursor: CURSOR,
  blob: { name: "blob", fit: "", ...BLOB, anchor: { x: 114, y: 100, scale: 0.58 } },
  circle: { name: "circle", fit: "", ...CIRCLE, anchor: { x: 114, y: 100, scale: 0.58 } },
  squircle: { name: "squircle", fit: "", ...SQUIRCLE, anchor: { x: 114, y: 102, scale: 0.56 } },
  diamond: { name: "diamond", fit: "", ...DIAMOND, anchor: { x: 114, y: 108, scale: 0.48 } },
  hexagon: { name: "hexagon", fit: "", ...HEXAGON, anchor: { x: 114, y: 104, scale: 0.52 } },
  teardrop: { name: "teardrop", fit: "", ...TEARDROP, anchor: { x: 114, y: 96, scale: 0.54 } },
  shield: { name: "shield", fit: "", ...SHIELD, anchor: { x: 114, y: 100, scale: 0.5 } },
};

export function resolveIconShape(value: unknown): IconShapeName {
  return ICON_SHAPE_NAMES.includes(value as IconShapeName) ? (value as IconShapeName) : "cursor";
}

export function shapeFor(name?: string | null): CursorShape {
  return SHAPES[resolveIconShape(name)];
}

export const ICON_SHAPES: CursorShape[] = ICON_SHAPE_NAMES.map((name) => SHAPES[name]);
