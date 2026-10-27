import { A } from "./a";
export let births = 0;
export class B {
  peer: A = new A();
  serial: number = ++births;
  constructor(public owner: A) {}
}
