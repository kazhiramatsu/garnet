// Typed class allocation must be safe when a field initializer allocates and
// immediately triggers young GC. Heap instances must be rooted as handles before
// later initializers, and stack/SROA instances must have safe default field bits.
class InitBox {
  label = "s";
  n = 7;
  z = 0;
  value(): number {
    return this.n + this.z;
  }
}

const g: any = globalThis;

const heapBox: any = new InitBox();
g.__typed_alloc_heap = heapBox;
console.log(heapBox.label, heapBox.value(), heapBox === g.__typed_alloc_heap);

const xs = [new InitBox(), new InitBox(), new InitBox()];
let labels = "";
let total = 0;
for (const x of xs) {
  labels = labels + x.label;
  total = total + x.value();
}
console.log(labels, total);

class GenBox {
  label = "g";
  *items(): Generator<string> {
    yield this.label;
  }
}

console.log([...new GenBox().items()].join(","));
