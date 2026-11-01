// FinalizationRegistry (docs/web_fetch_api_design.md's sense of a global the prelude installs). The specification lets an
// implementation never call the cleanup callback, and this one does not: the checks and the bookkeeping are real, the
// collector does not report back. A WeakRef holds its target strongly in the same spirit.

function canBeHeldWeakly(v: any): boolean {
  if ((typeof v === "object" && v !== null) || typeof v === "function") return true;
  return typeof v === "symbol" && Symbol.keyFor(v) === undefined;
}

export class FinalizationRegistry {
  #cells: { held: any; token: any }[] = [];
  constructor(cleanupCallback: any) {
    if (typeof cleanupCallback !== "function") throw new TypeError("FinalizationRegistry: cleanup must be callable");
  }
  register(target: any, heldValue: any, unregisterToken: any = undefined): void {
    if (!canBeHeldWeakly(target)) throw new TypeError("FinalizationRegistry.prototype.register: invalid target");
    if (Object.is(target, heldValue)) throw new TypeError("FinalizationRegistry.prototype.register: target and holdings must not be same");
    if (unregisterToken !== undefined && !canBeHeldWeakly(unregisterToken)) throw new TypeError("Invalid unregisterToken ('" + String(unregisterToken) + "')");
    this.#cells.push({ held: heldValue, token: unregisterToken });
  }
  unregister(unregisterToken: any): boolean {
    if (!canBeHeldWeakly(unregisterToken)) throw new TypeError("Invalid unregisterToken ('" + String(unregisterToken) + "')");
    const before = this.#cells.length;
    this.#cells = this.#cells.filter((c) => c.token !== unregisterToken);
    return this.#cells.length !== before;
  }
}
Object.defineProperty(FinalizationRegistry.prototype, Symbol.toStringTag, { value: "FinalizationRegistry", writable: false, enumerable: false, configurable: true });

export class WeakRef {
  #target: any;
  constructor(target: any) {
    if (!canBeHeldWeakly(target)) throw new TypeError("WeakRef: invalid target");
    this.#target = target;
  }
  deref(): any { return this.#target; }
}
Object.defineProperty(WeakRef.prototype, Symbol.toStringTag, { value: "WeakRef", writable: false, enumerable: false, configurable: true });
