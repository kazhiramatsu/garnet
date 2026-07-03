function main(): void {
  {
    const { Array } = { Array: 12 };
    console.log(Array);
    console.log(globalThis.Array === Array);
  }

  {
    const [Promise] = [13];
    console.log(Promise);
    console.log(globalThis.Promise === Promise);
  }

  function f(Object: any = 14): any {
    return Object;
  }
  console.log(f());
  console.log(Object === globalThis.Object);

  {
    const globalThis: any = { Array: 15 };
    console.log(globalThis.Array);
  }
  console.log(Array === globalThis.Array);

  {
    const Array = 1;
    try {
      throw 2;
    } catch (Array) {
      console.log(Array);
    }
    console.log(Array);
    console.log(globalThis.Array === Array);
  }

  {
    let Map: any = 1;
    let s = 0;
    for (let Map of [2, 3]) {
      s += Map;
    }
    console.log(s, Map);
    console.log(globalThis.Map === Map);
  }

  {
    class Promise {
      v(): number { return 16; }
    }
    console.log(new Promise().v());
  }
  console.log(Promise === globalThis.Promise);
}

main();
