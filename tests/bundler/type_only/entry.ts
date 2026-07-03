import type { Point, Pair } from "./types";
import { ZERO } from "./types";
const pt: Point = { x: 1, y: 2 };
const pr: Pair = [3, 4];
console.log(pt.x + pt.y + pr[0] + pr[1] + ZERO);
