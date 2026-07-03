import { Box, identity } from "./box";
const b = new Box<number>(42);
console.log(b.get(), identity("hi"), identity(99));
