// A stand-in for entities/decode: vue's tokenizer decodes entities itself only outside the browser
// configuration (garnet-stubs/globals.ts); in a browser the parser options' decodeEntities does it (the
// driver passes one). The names are declared so the imports resolve; the decoder throws if constructed.
export enum DecodingMode { Legacy = 0, Strict = 1, Attribute = 2 }
export const htmlDecodeTree: Uint16Array = new Uint16Array(0);
export function fromCodePoint(cp: number): string {
  return String.fromCodePoint(cp);
}
export class EntityDecoder {
  constructor(_tree: Uint16Array, _emit: (cp: number, consumed: number) => void) {
    throw new Error("garnet vue benchmark: entities/decode is not available");
  }
  startEntity(_mode: DecodingMode): void {}
  write(_str: string, _offset: number): number { return -1; }
  end(): number { return 0; }
}
export function decodeHTML(_str: string, _mode?: DecodingMode): never {
  throw new Error("garnet vue benchmark: entities/decode is not available");
}
