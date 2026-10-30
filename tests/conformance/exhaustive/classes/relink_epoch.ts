// Relinks of prototypes after the class caches were filled (the relink epoch: every cache derived
// from a class's chain refills), the relinks that keep the classes' intervals and method tables
// (a root class's prototype put behind a plain or a built-in prototype, as the String wrapper's
// library class is: this program writes `new String(...)`) and those that do not (a class
// prototype, or a prototype given a chain with a class prototype), and the site cache of an own
// function property of a class instance (hono's router assigns its matcher to `this.match`).
function callF(o: any): string { return o.f(); }
function callG(o: any): string { return typeof o.g === "function" ? o.g() : "no g"; }
function readG(o: any): string { return String(o.g); }

class Shape { area(): number { return 0; } name(): string { return "shape"; } }
class Sq extends Shape { constructor(public s: number) { super(); } area(): number { return this.s * this.s; } name(): string { return "sq"; } }
class Circ extends Shape { constructor(public r: number) { super(); } area(): number { return 3 * this.r * this.r; } }
function total(xs: Shape[]): string { let t = 0; const ns: string[] = []; for (const x of xs) { t += x.area(); ns.push(x.name()); } return t + " " + ns.join(","); }

class Root { f(): string { return "root.f"; } }
class Other { f(): string { return "other.f"; } g(): string { return "other.g"; } }
class Lone { f(): string { return "lone.f"; } }
class K { k(): string { return "K.k"; } g(): string { return "K.g"; } }

class Router {
  calls = 0;
  match(x: number): string { this.calls++; (this as any).match = (y: number) => "own " + y; return "proto " + x; }
}
function callMatch(o: any, v: number): string { return o.match(v); }

function main(): void {
  const out: string[] = [];
  // the String wrapper (its library class relinked behind String.prototype) and the classes' calls
  const s = new String("abc");
  out.push(String(s instanceof String), s.toUpperCase(), typeof s);
  const shapes: Shape[] = [new Sq(2), new Circ(1), new Shape()];
  out.push(total(shapes), String(shapes[0] instanceof Sq), String(shapes[1] instanceof Sq), String(shapes[1] instanceof Shape));

  // a root class's prototype behind a plain object, after the caches were filled
  const lone = new Lone();
  out.push(callF(lone), callG(lone), readG(lone));
  const mixin = { g(): string { return "mixin.g"; }, f(): string { return "mixin.f"; } };
  Object.setPrototypeOf(Lone.prototype, mixin);
  out.push(callF(lone), callG(lone), String(lone instanceof Lone), String((lone as any) instanceof K));
  // the plain object given a class prototype: now every Lone is a K
  Object.setPrototypeOf(mixin, K.prototype);
  out.push(String((lone as any) instanceof K), String(new Lone() instanceof Lone), (lone as any).k(), callG(lone));
  delete (mixin as any).g;
  out.push(callG(lone));

  // a root class's prototype behind another class's prototype after the caches were filled
  const r = new Root();
  out.push(callF(r), callG(r));
  Object.setPrototypeOf(Root.prototype, Other.prototype);
  out.push(callF(r), callG(r), String((r as any) instanceof Other), String(new Root() instanceof Root));
  // the classes' calls after the relinks
  out.push(total(shapes), total([new Sq(3)]), String(new Sq(1) instanceof Shape));

  // an own function property at a dynamic site
  const rt = new Router();
  for (let i = 0; i < 3; i++) out.push(callMatch(rt, i));
  (rt as any).match = (y: number) => "replaced " + y;
  out.push(callMatch(rt, 3));
  delete (rt as any).match;
  out.push(callMatch(rt, 4), callMatch(rt, 5));
  // another instance without the own property, then one whose sidecar holds another key first
  const rt2 = new Router();
  out.push(callMatch(rt2, 6), callMatch(rt2, 7));
  const rt3 = new Router(); (rt3 as any).extra = 1;
  out.push(callMatch(rt3, 8), callMatch(rt3, 9), callMatch(rt, 10));
  // the own property turned into an accessor, then into a value that is not a function
  Object.defineProperty(rt, "match", { get() { return (y: number) => "getter " + y; }, configurable: true });
  out.push(callMatch(rt, 11), callMatch(rt, 12));
  Object.defineProperty(rt, "match", { value: 13, writable: true, configurable: true });
  let threw = ""; try { callMatch(rt, 14); } catch (e) { threw = (e as Error).constructor.name; }
  out.push(threw, callMatch(rt2, 15), String(rt.calls + rt2.calls + rt3.calls));
  // the prototype method replaced after the sites cached it
  (Router.prototype as any).match = function (this: Router, x: number) { return "proto2 " + x; };
  out.push(callMatch(new Router(), 16), callMatch(rt2, 17));
  console.log(out.join("\n"));
}
main();
