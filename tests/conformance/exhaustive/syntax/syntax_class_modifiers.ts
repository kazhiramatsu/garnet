interface Describable {
  describe(): string;
}

abstract class AbstractBase implements Describable {
  protected prefix: string;
  readonly created: number = 1;
  public optional?: number;
  private hidden: number = 2;
  #hardPrivate = 3;

  constructor(public name: string, prefix = "base") {
    this.prefix = prefix;
  }

  abstract value(): number;

  describe(): string {
    return this.prefix + ":" + this.name + ":" +
      (this.hidden + this.#hardPrivate + this.created);
  }
}

class Concrete extends AbstractBase {
  static count = 0;
  static {
    Concrete.count += 10;
  }

  declare optional: number | undefined;

  constructor(name: string, private amount = 4) {
    super(name, "derived");
    Concrete.count++;
  }

  override value(): number {
    return this.amount;
  }

  get doubled(): number {
    return this.amount * 2;
  }

  set doubled(v: number) {
    this.amount = v / 2;
  }
}

function main(): void {
  const item = new Concrete("item", 5);
  console.log(item.describe(), item.value(), item.doubled, Concrete.count);
  item.doubled = 18;
  item.optional = 7;
  console.log(item.value(), item.optional);
  console.log(item instanceof Concrete, item instanceof AbstractBase);
}

main();
