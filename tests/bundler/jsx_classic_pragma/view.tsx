/** @jsx h */
/** @jsxFrag Frag */
import { h, Frag, render } from "./h";

function Item(p: { n: number; children?: unknown }) { return <li data-n={p.n}>{p.children}</li>; }

export function run(): void {
  console.log(render(<div />));
  console.log(render(<div a="1" b={2} c>one</div>));
  console.log(render(<div>a{"b"}{1}<i />{null}</div>));
  const xs = ["x", <b />];
  console.log(render(<p>{...xs}</p>));
  console.log(render(<p>first{...xs}<u />{...[1, 2]}</p>));
  console.log(render(<></>));
  console.log(render(<><i />{2}</>));
  console.log(render(<Item n={3}><em>e</em></Item>));
  const spread = { a: 1, b: 2 };
  console.log(render(<div {...spread} b="over" />));
  console.log(render(<svg:path stroke-width="2" xlink:href="#x" />));
  console.log(render(<p title="&amp;&nbsp;&copy;&#65;&#x42;&unknown;">x &lt; y &rarr; z</p>));
  // a factory in scope at the site: the parameter shadows the module's `h`
  const local = (h: (t: unknown, p: unknown, ...c: unknown[]) => string) => <span>{1}</span>;
  console.log(local((t, p, ...c) => `local(${String(t)},${String(p)},${c.length})`));
  console.log(Frag);
}
