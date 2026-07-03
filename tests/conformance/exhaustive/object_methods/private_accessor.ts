function main(): void {
  // private get + set, backed by a private field.
  class C {
    #v = 0;
    get #p(): number { return this.#v; }
    set #p(x: number) { this.#v = x; }
    use(): number { this.#p = 5; return this.#p; }
  }
  console.log(new C().use());            // 5

  // getter-only private accessor.
  class G {
    #v = 10;
    get #double(): number { return this.#v * 2; }
    read(): number { return this.#double; }
  }
  console.log(new G().read());           // 20

  // setter-only private accessor with side effect.
  class S {
    #log: number[] = [];
    set #p(x: number) { this.#log.push(x); }
    push(x: number): number { this.#p = x; return this.#log.length; }
  }
  const s = new S();
  console.log(s.push(7), s.push(8));     // 1 2

  // private accessor + private method coexisting.
  class M {
    #v = 1;
    get #p(): number { return this.#v; }
    #inc(): void { this.#v++; }
    go(): number { this.#inc(); return this.#p; }
  }
  console.log(new M().go());             // 2
}
main();
