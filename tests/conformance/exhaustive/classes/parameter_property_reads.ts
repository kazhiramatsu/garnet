// A constructor body reading its parameter properties by name
// (`constructor(private sys: Sys) { use(sys); }`): the parameter, not the
// class's property symbol, is the body's binding. Every modifier form, use in
// closures and in expressions, and a subclass. These read an unassigned
// local (undefined) before.
interface Sys { readonly dir: string; env(name: string): string }
function pretty(sys: Sys): boolean { return sys.env("NO_COLOR") === ""; }
class P1 { readonly v: string; constructor(private sys: Sys) { this.v = sys.dir; } }
class P2 { readonly v: string; constructor(readonly sys: Sys) { this.v = sys.dir + "!"; } }
class P3 { readonly v: string; constructor(public sys: Sys) { this.v = sys.dir.toUpperCase(); } }
class P4 { readonly v: string; constructor(protected readonly sys: Sys) { this.v = `${sys.dir}/x`; } }
class P5 {
  readonly read: () => string;
  constructor(private readonly sys: Sys, private n: number) {
    this.read = () => sys.dir + n;      // captured by a closure
    n += 1;                              // a write to the parameter, not the field
  }
  get(): string { return this.read() + "," + this.n + "," + this.sys.dir; }
}
class Reporter {
  private readonly quiet: boolean;
  private readonly isPretty: boolean;
  private readonly format: { dir: string };
  constructor(private readonly sys: Sys, options: { pretty?: boolean }, locale: string) {
    this.quiet = options.pretty === false;
    this.isPretty = options.pretty ?? pretty(sys);
    this.format = { dir: sys.dir + locale };
  }
  show(): string { return [this.quiet, this.isPretty, this.format.dir, this.sys.dir].join(); }
}
abstract class Host { constructor(readonly dir: string) {} abstract env(name: string): string; }
class NodeHost extends Host {
  constructor(dir: string, private readonly extra: string) { super(dir + extra.length); }
  env(name: string): string { return name === "NO_COLOR" ? "" : this.extra; }
}
const s: Sys = { dir: "/d", env: () => "" };
console.log(new P1(s).v, new P2(s).v, new P3(s).v, new P4(s).v, new P5(s, 1).get());
const host = new NodeHost("/tmp", "e");
console.log(new Reporter(host, {}, "en").show(), new Reporter(host, { pretty: false }, "ja").show());
