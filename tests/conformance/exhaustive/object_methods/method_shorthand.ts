function main(): void {
  const o: any = {
    v: 10,
    greet() { return 42; },
    getV() { return this.v; },
  };
  console.log(o.greet());                 // 42
  console.log(o.getV());                  // 10
  console.log(typeof o.greet);            // function
  console.log(Object.keys(o).join(","));  // v,greet,getV
  // a method is an ordinary property: extract and invoke as a value
  const m = o.greet;
  console.log(m());                        // 42
}
main();
