export class Box<T> {
  constructor(private val: T) {}
  get(): T { return this.val; }
}
export function identity<T>(x: T): T { return x; }
