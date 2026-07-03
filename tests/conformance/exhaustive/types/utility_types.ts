interface User { id: number; name: string; email: string; age: number; }

type PartialUser = Partial<User>;
type ReqUser = Required<PartialUser>;
type ROUser = Readonly<User>;
type NameEmail = Pick<User, "name" | "email">;
type NoEmail = Omit<User, "email">;
type Scores = Record<string, number>;
type T1 = Exclude<"a" | "b" | "c", "b">;
type T2 = Extract<"a" | "b" | "c", "a" | "c">;
type T3 = NonNullable<string | null | undefined>;

function f(): { a: number; b: number } { return { a: 1, b: 2 }; }
type FR = ReturnType<typeof f>;
type FP = Parameters<typeof Math.max>;

function main(): void {
  const pu: PartialUser = { name: "x" };
  const ru: ReqUser = { id: 1, name: "a", email: "e", age: 9 };
  const ro: ROUser = { id: 2, name: "b", email: "f", age: 8 };
  const ne: NameEmail = { name: "n", email: "m" };
  const no: NoEmail = { id: 3, name: "c", age: 7 };
  const sc: Scores = { math: 90, sci: 85 };
  const t1: T1 = "a"; const t2: T2 = "c"; const t3: T3 = "ok";
  const fr: FR = { a: 5, b: 6 };
  console.log(pu.name ?? "?", ru.age, ro.name, ne.email, no.id, sc.math + sc.sci, t1, t2, t3, fr.a + fr.b);
}
main();
