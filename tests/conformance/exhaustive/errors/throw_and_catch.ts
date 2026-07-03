function main(): void {
  // builtin Error carries its message.
  try { throw new Error("plain"); } catch (e: any) { console.log(e.message); }   // plain

  // Error subclass: super(msg) sets message; extra fields work.
  class MyErr extends Error {
    code: number;
    constructor(m: string, c: number) { super(m); this.code = c; }
  }
  try { throw new MyErr("bad", 42); } catch (e: any) { console.log(e.message, e.code); } // bad 42

  // named error kinds expose .name.
  try { throw new TypeError("nope"); } catch (e: any) { console.log(e.name, e.message); } // TypeError nope

  // nested try: rethrow from inner catch, caught by outer.
  try {
    try { throw new Error("inner"); }
    catch (e) { throw new Error("outer"); }
  } catch (e: any) { console.log(e.message); }                                    // outer

  // rethrow the SAME error object preserves its message.
  try {
    try { throw new Error("same"); }
    catch (e: any) { throw e; }
  } catch (e: any) { console.log(e.message); }                                    // same

  // throwing non-Error values.
  try { throw "str"; } catch (e) { console.log(e); }                              // str
  try { throw 99; } catch (e) { console.log(e); }                                 // 99

  // finally runs after catch; try inside a loop.
  let log = "";
  try { throw new Error("x"); } catch (e) { log += "c"; } finally { log += "f"; }
  console.log(log);                                                               // cf
  let s = 0;
  for (let i = 0; i < 5; i++) { try { if (i === 2) throw new Error("s"); s += i; } catch (e) {} }
  console.log(s);                                                                 // 0+1+3+4 = 8
}
main();
