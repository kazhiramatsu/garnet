interface SymbolConstructor {
  readonly dispose: unique symbol;
}
interface Disposable {
  [Symbol.dispose](): void;
}

class Disposable {
  [Symbol.dispose](): void {
    console.log("disposed");
  }
}

{
  using resource = new Disposable();
  console.log(resource instanceof Disposable);
}
