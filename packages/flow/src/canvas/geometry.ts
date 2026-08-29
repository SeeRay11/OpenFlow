export const NODE_WIDTH = 248
/** Vertical offset of both ports from the node's top edge. */
export const PORT_Y = 26
/**
 * Roughly half a card's height. Only the swarm mesh needs it: a peer link joins
 * two cards that have no direction between them, so it runs centre to centre
 * rather than port to port.
 */
export const NODE_HALF_HEIGHT = 34

export type Point = { x: number; y: number }

export function outPort(position: Point): Point {
  return { x: position.x + NODE_WIDTH, y: position.y + PORT_Y }
}

export function inPort(position: Point): Point {
  return { x: position.x, y: position.y + PORT_Y }
}

export function centre(position: Point): Point {
  return { x: position.x + NODE_WIDTH / 2, y: position.y + NODE_HALF_HEIGHT }
}

export function bezier(from: Point, to: Point) {
  const dx = Math.max(40, Math.abs(to.x - from.x) / 2)
  return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`
}
