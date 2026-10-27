import { defaults } from "./parser";
export type Transform = (s: string) => string;
export function count(): number { return defaults.name.length; }
