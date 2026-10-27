import { twice } from "./helpers";
export const quad = (n: number): number => twice(twice(n));
export function early(): string {
  try { return String(lateHelper(1)); } catch (e) { return e instanceof ReferenceError ? "tdz" : "other"; }
}
export const probe = early();   // runs before lateHelper's declaration: the TDZ
export const lateHelper = (n: number): number => n + 100;
