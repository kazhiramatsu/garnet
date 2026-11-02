// DOMException: an Error with a legacy numeric code by its name (a program that names it compiles this; `structuredClone` throws it).

const CODES: Record<string, number> = {
  IndexSizeError: 1, HierarchyRequestError: 3, WrongDocumentError: 4, InvalidCharacterError: 5, NoModificationAllowedError: 7,
  NotFoundError: 8, NotSupportedError: 9, InUseAttributeError: 10, InvalidStateError: 11, SyntaxError: 12, InvalidModificationError: 13,
  NamespaceError: 14, InvalidAccessError: 15, TypeMismatchError: 17, SecurityError: 18, NetworkError: 19, AbortError: 20,
  URLMismatchError: 21, QuotaExceededError: 22, TimeoutError: 23, InvalidNodeTypeError: 24, DataCloneError: 25,
};
export class DOMException extends Error {
  #name: string;
  constructor(message: unknown = "", options: unknown = "Error") {
    super(`${message}`);
    if (typeof options === "object" && options !== null) {
      const o = options as { name?: unknown; cause?: unknown };
      if ("cause" in o) Object.defineProperty(this, "cause", { value: o.cause, writable: true, enumerable: false, configurable: true });
      this.#name = o.name === undefined ? "Error" : `${o.name}`;
    } else this.#name = `${options}`;
  }
  override get name(): string { return this.#name; }
  get code(): number { return Object.prototype.hasOwnProperty.call(CODES, this.#name) ? CODES[this.#name] : 0; }
  get [Symbol.toStringTag](): string { return "DOMException"; }
}
