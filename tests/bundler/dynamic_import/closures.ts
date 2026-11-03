export const fns: any[] = [];
for (let i = 0; i < 3; i++) fns.push(() => i);
let hidden = 0;
{ let block = 5; hidden = block + 1; fns.push(() => block); }
export function getBlock() { return hidden; }
enum E { A, B }
namespace N { export const v = 3; }
fns.push(() => E.B + N.v);
