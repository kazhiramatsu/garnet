/** @jsx lib.h */
/** @jsxFrag lib.Frag */
// the factory as a namespace import's member (`React.createElement`'s form under another name)
import * as lib from "./h";

export function run2(): void {
  console.log(lib.render(<div a="1">x<i /></div>));
  console.log(lib.render(<>{1}{2}</>));
}
