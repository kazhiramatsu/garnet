/// <reference lib="es2022" />
// ES2022 error cause and AggregateError: `new E(message, options)` (the options' cause, own or
// inherited, through a getter; options that are not objects; the message's ToString and
// undefined; the arguments evaluated in order), a subclass's `super(message, options)` with an
// explicit constructor and without one (also through a class value), AggregateError's errors from
// an iterable, the constructors as values, Reflect.construct, Promise.any's AggregateError.
const show = (e: Error): string => {
  const own = Object.getOwnPropertyNames(e).filter((k) => k !== "stack").sort().join(",");
  const c = (e as { cause?: unknown }).cause;
  return `${e.name} msg=${JSON.stringify(e.message)} own=[${own}] keys=[${Object.keys(e).join(",")}] cause=${c instanceof Error ? "Error(" + c.message + ")" : String(c)} hasCause=${"cause" in e}`;
};
const inner = new Error("inner");
console.log(show(new Error("a", { cause: inner })));
console.log(show(new TypeError(undefined, { cause: 5 })));
console.log(show(new RangeError("r", {})));
console.log(show(new SyntaxError("s", { cause: undefined })));
console.log(show(new URIError("u", { cause: null })));
const proto = { cause: "inherited" };
console.log(show(new Error("p", Object.create(proto))));
let reads = 0;
console.log(show(new Error("g", { get cause() { reads++; return "got"; } })), reads);
console.log(show(new Error("n", 42 as unknown as ErrorOptions)));
console.log(show(new Error("s", "str" as unknown as ErrorOptions)));
const order: string[] = [];
const e1 = new Error((order.push("m"), "msg"), (order.push("o"), { cause: 1 }));
console.log(order.join(""), show(e1));
console.log(show(new Error(42 as unknown as string)));
class HttpError extends Error {
  constructor(public status: number, message?: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
console.log(show(new HttpError(401, "nope", { cause: inner })), new HttpError(500).status);
console.log(show(new HttpError(500)));
class Plain extends Error {}
console.log(show(new Plain("plain", { cause: "c" })));
class WithCtor extends Error { constructor(m: string, o?: ErrorOptions) { super(m, o); this.name = "WithCtor"; } }
const K = Plain as unknown as new (...a: unknown[]) => Error;
console.log(show(new K("poly", { cause: "pc" })));
const ks: (new (m: string, o?: ErrorOptions) => Error)[] = [Plain, WithCtor, Error, TypeError];
for (const C of ks) console.log(show(new C("each", { cause: C.name })));
const spread: [string, ErrorOptions] = ["spread", { cause: "sp" }];
console.log(show(new WithCtor(...spread)));
class Agg extends AggregateError {
  constructor(errs: unknown[], m: string) { super(errs, m, { cause: "agg" }); }
}
const ag = new Agg([1, 2], "two");
console.log(show(ag), ag.errors);
const a = new AggregateError([new Error("x"), 2], "both", { cause: "why" });
console.log(show(a), a.errors.length, a.errors[1]);
console.log(show(new AggregateError(new Set(["s"]))), new AggregateError(new Set(["s"])).errors);
try { new AggregateError(undefined as unknown as unknown[]); } catch (e) { console.log("not iterable:", (e as Error).name); }
const E: ErrorConstructor = TypeError;
console.log(show(new E("v", { cause: "val" })));
const A: AggregateErrorConstructor = AggregateError;
console.log(show(new A([3], "av")), new A([3], "av").errors);
console.log(show(Error("called", { cause: "nonew" })));
console.log(show(Reflect.construct(Error, ["reflect", { cause: "r" }])));
Promise.any([Promise.reject(new Error("a")), Promise.reject(2)]).catch((e: AggregateError) => console.log(show(e), e.errors.length));
