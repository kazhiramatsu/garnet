// vue's @vue/shared shape: helpers as module-level const arrows, exported and re-exported
export const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";
export const isArray: typeof Array.isArray = Array.isArray;
export const hasOwn = (o: object, k: string | symbol): boolean => Object.prototype.hasOwnProperty.call(o, k);
export const extend: typeof Object.assign = Object.assign;
let seq = 0;
export const nextId = (): number => ++seq;             // reads a module `let`: a capture-free module binding
export const twice = (n: number): number => n * 2;
export const compose = <A, B, C>(f: (a: A) => B, g: (b: B) => C) => (a: A): C => g(f(a));
