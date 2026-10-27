export enum Flags { SKIP = "__v_skip", RAW = "__v_raw", N = 3 }
export enum Kind { A, B, C = Flags.N * 2 }
export function classify(key: string): number { return key === Flags.SKIP ? 1 : key === Flags.RAW ? 2 : 0; }
