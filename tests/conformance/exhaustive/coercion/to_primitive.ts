function main(): void {
  // valueOf drives Number() and numeric `+`.
  class N { valueOf(): number { return 42; } }
  console.log(Number(new N()));        // 42
  console.log(new N() + 5);            // 47

  // toString drives String() and string `+`.
  class S { toString(): string { return "hi"; } }
  console.log(String(new S()));        // hi
  console.log(new S() + "!");          // hi!

  // Symbol.toPrimitive takes precedence, with the right hint.
  const o: any = {
    [Symbol.toPrimitive](hint: string): any {
      return hint === "number" ? 7 : hint === "string" ? "str" : "def";
    }
  };
  console.log(Number(o));              // 7
  console.log(String(o));              // str
  console.log(o + "");                 // def  (default hint, then string concat)
}
main();
