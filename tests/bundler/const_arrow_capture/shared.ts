// Module-level const arrows that read other bindings of their own module (vue's `isIntegerKey` reads
// `isString`): called directly from another module, the caller supplies the module's record it holds.
export const isStr = (v: unknown): v is string => typeof v === "string";
export const isIntKey = (k: unknown): boolean => isStr(k) && k !== "NaN" && k[0] !== "-" && "" + parseInt(k, 10) === k;
let factor = 2;
export const scale = (n: number): number => n * factor;           // reads a module `let`: the current value
export const setFactor = (f: number): void => { factor = f; };
const prefix = String.fromCharCode(112) + ":";
export const tagged = (s: string): string => `${prefix}${s}`;
