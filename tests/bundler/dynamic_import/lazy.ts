import { shared } from "./shared";
import { dep } from "./dep";
console.log("lazy evaluated", dep);
export let value = 1 + shared;
export function fn(x: number) { return x + value; }
export class K { v = value * 2; static s = console.log("static of K"); }
export function seen() { return shared; }
export function setValue(v: number) { value = v; }
export default function dflt() { return 1; }
