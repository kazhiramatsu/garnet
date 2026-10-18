import { Box, allocate } from "./box";
import * as values from "./values";

const box = allocate([Box]);
console.log(box.value, values.read(), values.current);
values.update(9);
console.log(box.value, values.read(), values.current);
