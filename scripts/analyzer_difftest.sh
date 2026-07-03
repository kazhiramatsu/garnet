#!/bin/bash
# Differential harness for the self-hosting TypeScript analyzer (analyzer_ts/).
#
# For each input .ts: exporter -> IR JSON, then emit C with BOTH the Rust analyzer
# and the TS analyzer, compile+run both, and compare their stdout to each other
# AND to the node ESM oracle. The TS analyzer is correct iff all three agree.
#
# Usage: scripts/analyzer_difftest.sh [file1.ts file2.ts ...]
#        (with no args, runs the built-in smoke programs)
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CC="${TSAOT_CC:-cc -O2}"
RUST="$ROOT/analyzer/target/release/tsaot"
TSAN="node $ROOT/analyzer_ts/dist/main.js"
EXPORTER="$ROOT/exporter/exporter.js"

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
export ROOT CC
. "$ROOT/scripts/mimalloc_flags.sh" 2>/dev/null || true
. "$ROOT/scripts/regexp_link_flags.sh" || { echo "regexp link flags missing"; exit 1; }
$CC -c "$ROOT/runtime/ts_rt.c" -I"$ROOT/runtime" -o "$tmp/rt.o" 2>/dev/null || { echo "runtime build failed"; exit 1; }

cc_link() { # $1=src.c $2=out
  tsaot_prepare_regexp_objs "$1" "$tmp" >/dev/null 2>&1
  tsaot_prepare_unicode_objs "$1" "$tmp" >/dev/null 2>&1
  tsaot_prepare_fetch_runtime "$1" "$tmp" "$tmp/rt.o" >/dev/null 2>&1
  # shellcheck disable=SC2086
  $CC "$1" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS \
    -I"$ROOT/runtime" -lm $TSAOT_FETCH_LDLIBS ${TSAOT_LDLIBS:-} -o "$2" 2>"$3"
}

pass=0; fail=0

run_one() {
  local ts="$1" label="$2"
  # exporter (untyped keeps it robust to any type quirks in tiny snippets)
  if ! TSAOT_UNTYPED=1 node "$EXPORTER" "$ts" "$tmp/ir.json" "$tmp/l.json" >/dev/null 2>"$tmp/exp.err"; then
    echo "[difftest] FAIL $label: exporter error"; sed 's/^/    /' "$tmp/exp.err"; fail=$((fail+1)); return
  fi
  # node oracle: transpile TS -> ESM .mjs (strip types), then run (same as difftest.sh)
  local oracle
  if ! NODE_PATH="$ROOT/exporter/node_modules" node "$ROOT/scripts/_oracle_transpile.js" "$ts" "$tmp/oracle.mjs" 2>"$tmp/tr.err"; then
    echo "[difftest] FAIL $label: oracle transpile error"; sed 's/^/    /' "$tmp/tr.err" | head; fail=$((fail+1)); return; fi
  oracle=$(node "$tmp/oracle.mjs" 2>&1)
  # rust analyzer
  if ! $RUST "$tmp/ir.json" emit > "$tmp/rust.c" 2>"$tmp/rust.err"; then
    echo "[difftest] FAIL $label: rust analyzer error"; sed 's/^/    /' "$tmp/rust.err"; fail=$((fail+1)); return; fi
  # ts analyzer
  if ! $TSAN "$tmp/ir.json" emit > "$tmp/ts.c" 2>"$tmp/ts.err"; then
    echo "[difftest] FAIL $label: TS analyzer error"; sed 's/^/    /' "$tmp/ts.err"; fail=$((fail+1)); return; fi
  # compile + run both
  local rout tout
  if ! cc_link "$tmp/rust.c" "$tmp/rust.bin" "$tmp/rustcc.err"; then
    echo "[difftest] FAIL $label: rust C did not compile"; sed 's/^/    /' "$tmp/rustcc.err" | head; fail=$((fail+1)); return; fi
  if ! cc_link "$tmp/ts.c" "$tmp/ts.bin" "$tmp/tscc.err"; then
    echo "[difftest] FAIL $label: TS C did not compile"; sed 's/^/    /' "$tmp/tscc.err" | head; fail=$((fail+1)); return; fi
  rout=$("$tmp/rust.bin" 2>&1); tout=$("$tmp/ts.bin" 2>&1)
  if [ "$tout" = "$rout" ] && [ "$tout" = "$oracle" ]; then
    echo "[difftest] PASS $label"; pass=$((pass+1))
  else
    echo "[difftest] FAIL $label: outputs differ"
    echo "    node  : $(printf '%s' "$oracle" | tr '\n' '|')"
    echo "    rust  : $(printf '%s' "$rout"   | tr '\n' '|')"
    echo "    ts    : $(printf '%s' "$tout"   | tr '\n' '|')"
    fail=$((fail+1))
  fi
}

if [ $# -gt 0 ]; then
  for f in "$@"; do run_one "$f" "$(basename "$f")"; done
else
  # built-in smoke programs (Phase 0/1 ported-instruction regression set)
  echo 'console.log(1+1);' > "$tmp/p_add.ts";           run_one "$tmp/p_add.ts" "add"
  echo 'console.log(2+3+4);' > "$tmp/p_add3.ts";        run_one "$tmp/p_add3.ts" "add3"
  printf 'let x=5;x=x*2-1;console.log(x,x>8,x%%3,x&6,~x,-x,x**2,typeof x);\n' > "$tmp/p_arith.ts"
  run_one "$tmp/p_arith.ts" "arith"
  printf 'const o={x:1,y:2};o.x=o.x+10;console.log(o.x,o.y,o.x+o.y);\n' > "$tmp/p_obj.ts"
  run_one "$tmp/p_obj.ts" "obj"
  printf 'const a=[10,20,30];let s=0;for(let i=0;i<a.length;i=i+1){s=s+a[i];}console.log(s,a.length,a[1]);\n' > "$tmp/p_arr.ts"
  run_one "$tmp/p_arr.ts" "arr"
  printf 'const g=[[1,2],[3,4]];let t=0;for(let i=0;i<g.length;i=i+1)for(let j=0;j<g[i].length;j=j+1)t=t+g[i][j];console.log(t);\n' > "$tmp/p_nest.ts"
  run_one "$tmp/p_nest.ts" "nest"
  printf 'const s="ab"+"cd";console.log(s,s.length,typeof s,s==="abcd");\n' > "$tmp/p_str.ts"
  run_one "$tmp/p_str.ts" "str"
  printf 'let n=0;for(let i=0;i<5;i=i+1){if(i===2)continue;if(i===4)break;n=n+i;}console.log(n);\n' > "$tmp/p_ctl.ts"
  run_one "$tmp/p_ctl.ts" "ctl"
  printf 'function add(a,b){return a+b;}const d=x=>x*2;console.log(add(3,4),d(10),add(d(2),1));\n' > "$tmp/p_fn.ts"
  run_one "$tmp/p_fn.ts" "fn"
  printf 'function counter(){let n=0;return ()=>{n=n+1;return n;};}const c=counter();console.log(c(),c(),c());\n' > "$tmp/p_clo.ts"
  run_one "$tmp/p_clo.ts" "clo"
  printf 'const o={base:10,add(x){return this.base+x;}};console.log(o.add(5),o.add(20));\n' > "$tmp/p_mth.ts"
  run_one "$tmp/p_mth.ts" "method"
  printf 'const a=[3,1,2];console.log(a.map(x=>x*2).filter(x=>x>2).join(","),a.indexOf(2),"hi".toUpperCase());\n' > "$tmp/p_bm.ts"
  run_one "$tmp/p_bm.ts" "builtin-methods"
  printf 'function pipe(x,...fns){return fns.reduce((a,f)=>f(a),x);}console.log(pipe(3,x=>x+1,x=>x*2,x=>x+1));\n' > "$tmp/p_rest.ts"
  run_one "$tmp/p_rest.ts" "rest-params"
  printf 'class P{x;y;constructor(x,y){this.x=x;this.y=y;}sum(){return this.x+this.y;}}const p=new P(3,4);console.log(p.x,p.y,p.sum());\n' > "$tmp/p_cls.ts"
  run_one "$tmp/p_cls.ts" "class"
  printf 'class A{n;constructor(n){this.n=n;}speak(){return this.n+"!";}}class B extends A{constructor(n){super(n);}speak(){return this.n+"?";}}console.log(new A("a").speak(),new B("b").speak(),new B("b") instanceof A);\n' > "$tmp/p_inh.ts"
  run_one "$tmp/p_inh.ts" "inheritance"
  printf 'const o={a:1};const k="a";o[k]=5;console.log(o[k],`v=${o.a}`);\n' > "$tmp/p_dyn.ts"
  run_one "$tmp/p_dyn.ts" "dyn-field+template"
  printf 'const m=new Map();m.set("a",1);const s=new Set();s.add(1);s.add(1);console.log(m.get("a"),m.size,s.has(1),s.size);\n' > "$tmp/p_ms.ts"
  run_one "$tmp/p_ms.ts" "map-set"
  printf 'function f(x){if(x<0)throw new Error("neg");return x*2;}try{console.log(f(5));console.log(f(-1));}catch(e){console.log("c:"+e.message);}finally{console.log("fin");}\n' > "$tmp/p_tc.ts"
  run_one "$tmp/p_tc.ts" "try-catch-finally"
  printf 'class T{_c=0;get c(){return this._c;}set c(v){this._c=v;}}const t=new T();t.c=9;console.log(t.c);\n' > "$tmp/p_acc.ts"
  run_one "$tmp/p_acc.ts" "getter-setter"
  printf 'const f=parseInt;console.log(f("9z",10),JSON.stringify({a:1}),Object.keys({x:1,y:2}).join(","),Math.max(1,9,3));\n' > "$tmp/p_bi.ts"
  run_one "$tmp/p_bi.ts" "builtins"
  printf 'function sum(...xs){let s=0;for(const x of xs)s=s+x;return s;}const a=[1,2,3];class A{n;constructor(n){this.n=n;}}class B extends A{}console.log(sum(...a,4),new B(7).n);\n' > "$tmp/p_sp.ts"
  run_one "$tmp/p_sp.ts" "spread+implicit-super"
  printf 'const o={a:1,b:2};delete o.a;console.log(JSON.stringify(o),[1,2,3,4,5].slice(2).join(","));\n' > "$tmp/p_ds.ts"
  run_one "$tmp/p_ds.ts" "delete+slice"
  printf 'console.log(/(\\d+)-(\\d+)/.test("12-34"),"a1b2c3".match(/\\d/g).join(","),"a1b2".replace(/\\d/g,"#"),"a,b,c".split(/,/).join("|"));\n' > "$tmp/p_rx.ts"
  run_one "$tmp/p_rx.ts" "regexp"
  printf 'const s=Symbol("x");const o={};o[s]=5;console.log(typeof s,s.description,s.toString(),o[s]);\n' > "$tmp/p_sym.ts"
  run_one "$tmp/p_sym.ts" "symbol"
  printf 'function* gen(){const a=yield 1;yield a+1;yield 3;}for(const x of gen())console.log(x);const g=gen();console.log(g.next().value,g.next(100).value);\n' > "$tmp/p_gen.ts"
  run_one "$tmp/p_gen.ts" "generator"
  printf 'async function g(){const x=await Promise.resolve(5);const y=await Promise.resolve(x*2);return y+1;}g().then(v=>console.log("g",v));async function f(){return 42;}f().then(v=>console.log("f",v));\n' > "$tmp/p_async.ts"
  run_one "$tmp/p_async.ts" "async"
  printf 'function* range(n){for(let i=0;i<n;i=i+1)yield i;}let s=0;for(const x of range(5))s=s+x;console.log(s);\n' > "$tmp/p_genloop.ts"
  run_one "$tmp/p_genloop.ts" "generator-in-loop"
  printf 'async function sa(n){let t=0;for(let i=0;i<n;i=i+1){t=t+await Promise.resolve(i);}return t;}sa(4).then(v=>console.log("sa",v));\n' > "$tmp/p_awaitloop.ts"
  run_one "$tmp/p_awaitloop.ts" "await-in-loop"
  printf 'const s=new Set([1,2,2,3]);const m=new Map([["a",1],["b",2]]);console.log(s.size,m.get("a"),[...s].join(","));\n' > "$tmp/p_seed.ts"
  run_one "$tmp/p_seed.ts" "set/map-seed"
  printf 'class A{} const a=new A(); console.log(a instanceof A, a instanceof Object, ({}) instanceof A);class E extends Error{constructor(m){super(m);}}const e=new E("x");console.log(e.message,e instanceof E,e instanceof Error);\n' > "$tmp/p_inst.ts"
  run_one "$tmp/p_inst.ts" "instanceof+extends-Error"
  printf 'const slice=Array.prototype.slice;console.log(slice.call([1,2,3,4],1,3).join(","));const r=/ab+/g;const t=r.test;console.log(t.call(r,"zabbb"));\n' > "$tmp/p_lmv.ts"
  run_one "$tmp/p_lmv.ts" "method-value+regexp"
  printf 'class P{x;y;constructor(x,y){this.x=x;this.y=y;}sum(){return this.x+this.y;}}function make(C){return new C(3,4);}const p=make(P);console.log(p.x,p.y,p.sum(),p instanceof P);\n' > "$tmp/p_nd.ts"
  run_one "$tmp/p_nd.ts" "new-dynamic"
  printf 'async function f(){try{await Promise.reject(new Error("boom"));}catch(e){return "caught:"+e.message;}finally{console.log("fin");}}f().then(v=>console.log(v));\n' > "$tmp/p_coroeh.ts"
  run_one "$tmp/p_coroeh.ts" "coro-eh(async-try-catch-finally)"
  printf 'function* g(){try{yield 1;yield 2;}catch(e){yield "c:"+e;}yield 9;}const it=g();console.log(it.next().value,it.throw("x").value,it.next().value);\n' > "$tmp/p_genth.ts"
  run_one "$tmp/p_genth.ts" "coro-eh(gen-throw-into-try)"
  printf 'function* g(){yield 1;return 42;}const it=g();console.log(JSON.stringify(it.next()),JSON.stringify(it.next()),JSON.stringify(it.next()));\n' > "$tmp/p_genrv.ts"
  run_one "$tmp/p_genrv.ts" "generator-return-value"
  printf 'async function* ag(n){for(let i=0;i<n;i=i+1){yield await Promise.resolve(i*3);}}(async()=>{let s=0;for await (const v of ag(4))s=s+v;console.log("ag",s);})();\n' > "$tmp/p_agen.ts"
  run_one "$tmp/p_agen.ts" "async-generator"
  printf 'const o={a:1,b:2,c:3};const {a,...rest}=o;console.log(a,JSON.stringify(rest));const arr=[1,2,3,4,5];console.log(arr.splice(1,2,9).join(","),arr.join(","),[0,1,2,3].splice(2).join(","));\n' > "$tmp/p_rest2.ts"
  run_one "$tmp/p_rest2.ts" "object-rest+splice"
  printf 'outer:for(let i=0;i<3;i=i+1){for(let j=0;j<3;j=j+1){if(j===2)continue outer;if(i===2)break outer;console.log(i,j);}}\n' > "$tmp/p_lbl.ts"
  run_one "$tmp/p_lbl.ts" "labeled-break-continue"
  printf 'class R{n;constructor(n){this.n=n;}[Symbol.iterator](){let i=0;const n=this.n;return {next:()=>i<n?{value:i++,done:false}:{value:0,done:true}};}}console.log([...new R(4)].join(","));for(const x of new R(3))console.log(x);\n' > "$tmp/p_iter.ts"
  run_one "$tmp/p_iter.ts" "custom-iterator(wksym-class-method)"
fi

echo "[difftest] PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
