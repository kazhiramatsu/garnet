interface SymbolConstructor {
  readonly dispose: unique symbol;
  readonly asyncDispose: unique symbol;
}
interface Disposable {
  [Symbol.dispose](): void;
}
interface AsyncDisposable {
  [Symbol.asyncDispose](): PromiseLike<void>;
}

class AsyncDisposable {
  async [Symbol.asyncDispose](): Promise<void> {
    console.log("disposed");
  }
}

async function main(): Promise<void> {
  await using resource = new AsyncDisposable();
  console.log(resource instanceof AsyncDisposable);
}

main();
