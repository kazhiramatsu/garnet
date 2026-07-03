// Generic class methods taking callbacks + returning `this`/new generic instances,
// stored in collections and dispatched — stresses SROA/devirt/monomorphization.
class Observable<T> {
  private subs: ((v: T) => void)[] = [];
  constructor(private value: T) {}
  subscribe(f: (v: T) => void): this { this.subs.push(f); return this; }
  set(v: T): this { this.value = v; for (const f of this.subs) f(v); return this; }
  get(): T { return this.value; }
  map<U>(f: (v: T) => U): Observable<U> { return new Observable(f(this.value)); }
}
class Result<T> {
  constructor(private ok: boolean, private val: T) {}
  static good<T>(v: T): Result<T> { return new Result(true, v); }
  fold<U>(onOk: (v: T) => U, onErr: () => U): U { return this.ok ? onOk(this.val) : onErr(); }
  chain<U>(f: (v: T) => Result<U>): Result<U> { return this.ok ? f(this.val) : new Result<U>(false, undefined as any); }
}
function main(): void {
  let seen: number[] = [];
  const o = new Observable(0);
  o.subscribe(v => seen.push(v)).subscribe(v => seen.push(v * 10));
  o.set(1).set(2);
  console.log(seen.join(","));                       // 1,10,2,20
  console.log(o.map(x => x + 100).map(x => "v" + x).get());  // v102
  const r = Result.good(5).chain(x => Result.good(x * 2)).fold(x => "ok:" + x, () => "err");
  console.log(r);                                    // ok:10
  const obs = [new Observable(1), new Observable(2), new Observable(3)];
  console.log(obs.map(o => o.map(x => x * x).get()).join(",")); // 1,4,9
}
main();
