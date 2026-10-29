/** @jsxImportSource . */
// JSX under the automatic runtime (docs/jsx_react_ssr_design.md "The automatic runtime"): `jsx` for one
// child, `jsxs` for several or a spread child, the children in the props after the attributes, the key
// as the third argument (evaluated after the props), fragments through `Fragment`, namespaced names,
// the named character references, the whitespace rules.
import { render } from "./jsx-runtime";

type CardProps = { title: string; n?: number; children?: unknown };
function Card(p: CardProps) { return <section class="card" data-n={p.n}>{p.title}{p.children}</section>; }
const Named = { Box: (p: { children?: unknown }) => <div class="box">{p.children}</div> };

export function run(): void {
  console.log(render(<div />));
  console.log(render(<div a="1" b={2} c />));
  console.log(render(<div key="k" a="1">one</div>));
  console.log(render(<div>a{"b"}{1}<i />{null}{false}{undefined}</div>));
  console.log(render(<ul>{[1, 2].map((i) => <li key={i}>{i}</li>)}</ul>));
  const xs = [<b />, "t"];
  console.log(render(<p>{...xs}</p>));
  console.log(render(<p>{...xs}<u /></p>));
  console.log(render(<></>));
  console.log(render(<>x</>));
  console.log(render(<><i />{2}</>));
  console.log(render(<Card title="T" n={3}><em>e</em></Card>));
  console.log(render(<Card title="U" />));
  console.log(render(<Named.Box>z</Named.Box>));
  const spread = { a: 1, b: 2 };
  console.log(render(<div {...spread} b="over" />));
  console.log(render(<div c="first" {...spread} />));
  const log: string[] = [];
  const order = <T,>(s: string, v: T): T => { log.push(s); return v; };
  console.log(render(<div key={order("key", "K")} a={order("a", 1)}>{order("child", "c")}</div>), log.join(","));
  console.log(render(<svg:path stroke-width="2" xlink:href="#x" />));
  console.log(render(<p title="a &amp; b &lt; &quot;c&quot; &nbsp;&copy;&#65;&#x42;&unknown;">x &amp;&mdash;y &zwnj;z</p>));
  console.log(render(<div>
      multi
      line   text
    </div>));
  console.log(render(<div>{/* a comment */}</div>));
  console.log(render(<div>{}</div>));
  let v = 1;
  console.log(render(<div>{v}{v = 2}{v}</div>));
}
