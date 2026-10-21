// Classes declared once in this module, used as values and with `instanceof`
// from the entry (imported bindings).
export abstract class Base { kind = 0; label(): string { return "base"; } }
export class Leaf extends Base { text = "leaf"; label(): string { return "leaf:" + this.text; } }
export class Mid extends Base { n = 1; }
export class Deep extends Mid { d = 2; label(): string { return "deep"; } }
export function makeFresh(): { cls: new () => Base; v: Base } {
  class Fresh extends Base { f = 3; }
  return { cls: Fresh, v: new Fresh() };
}
