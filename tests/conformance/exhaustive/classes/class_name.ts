class NamePlain {}
class NameWithCtor {
  constructor(public x: number, y = 1) {}
}

function makeLocalClass() {
  class LocalName {}
  return LocalName;
}

function main(): void {
  console.log(NamePlain.name); // NamePlain
  console.log((NamePlain as any).name); // NamePlain
  const K = NameWithCtor;
  console.log(K.name); // NameWithCtor
  console.log(K.length); // 1
  const L = makeLocalClass();
  console.log(L.name); // LocalName
}
main();
