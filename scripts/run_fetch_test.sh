#!/usr/bin/env bash
# fetch / HTTPS transport test. By default this only verifies that fetch
# programs COMPILE and LINK (network-independent, CI/sandbox-safe). Set
# TSAOT_NET=1 to perform a live HTTPS request against an allowlisted host.
# TSAOT_FETCH_LOCAL=auto tries the localhost POST echo test and skips when
# bind is unavailable; TSAOT_FETCH_LOCAL=1 requires it to run.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RT_SRC="runtime/ts_rt.c"; INC="runtime"
BIN="analyzer/target/release/tsaot"
CC="${TSAOT_CC:-gcc -O2}"
TSAOT_LDLIBS="${TSAOT_LDLIBS:-}"
. "$ROOT/scripts/lib/mimalloc_flags.sh" || exit 1
. "$ROOT/scripts/lib/regexp_link_flags.sh" || exit 1
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
rc=0

RT_OBJ="$tmp/ts_rt.o"
if ! $CC -c "$RT_SRC" -I"$INC" -o "$RT_OBJ" 2>"$tmp/rt.cc.err"; then
  echo "[fetch] FAIL: runtime compile error"; cat "$tmp/rt.cc.err"; exit 1
fi

link_generated() {
  local cfile="$1"
  local out="$2"
  local ccerr="$3"
  local fail_msg="$4"
  if ! tsaot_prepare_regexp_objs "$cfile" "$tmp" 2>"$ccerr.rx"; then
    echo "[fetch] FAIL: RegExp link prep"; cat "$ccerr.rx"; exit 1
  fi
  if ! tsaot_prepare_unicode_objs "$cfile" "$tmp" 2>"$ccerr.uc"; then
    echo "[fetch] FAIL: Unicode link prep"; cat "$ccerr.uc"; exit 1
  fi
  if ! tsaot_prepare_fetch_runtime "$cfile" "$tmp" "$RT_OBJ" 2>"$ccerr.fetch"; then
    echo "[fetch] FAIL: fetch link prep"; cat "$ccerr.fetch"; exit 1
  fi
  if ! $CC "$cfile" "$TSAOT_FETCH_RT_OBJ_ARG" $TSAOT_REGEXP_OBJ_ARGS $TSAOT_UNICODE_OBJ_ARGS -I"$INC" -lm $TSAOT_FETCH_LDLIBS $TSAOT_LDLIBS -o "$out" 2>"$ccerr"; then
    echo "$fail_msg"; cat "$ccerr"; exit 1
  fi
}

cat > "$tmp/fetch.ts" <<'TS'
async function main(): Promise<void> {
  const r = await fetch("https://api.github.com/zen");
  console.log(r.status >= 0);
  console.log(typeof (r as any).headers === "object");
  const ct = r.headers.get("content-type");
  console.log(ct === null || typeof ct === "string");
  console.log(typeof r.headers.has("content-type") === "boolean");
  let keyCount = 0;
  for (const _k of (r.headers.keys() as any)) keyCount++;
  console.log(keyCount >= 0);
  let entriesOk = true;
  for (const [k, v] of (r.headers as any)) {
    if (typeof k !== "string" || typeof v !== "string") entriesOk = false;
  }
  console.log(entriesOk);
  console.log(!Object.isFrozen(r.headers as any));   // Node's response headers are not a frozen object (the guard is the class's)
  try {
    r.headers.set("x-tsaot-mut", "one");
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
  }
  try {
    r.headers.append("X-Tsaot-Mut", "two");
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
  }
  console.log(r.headers.get("x-tsaot-mut") === null);
  (r.headers as any)["x-tsaot-mut"] = "direct";
  console.log(r.headers.get("x-tsaot-mut") === null);
  try {
    r.headers.delete("X-Tsaot-Mut");
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
  }
  console.log(!r.headers.has("x-tsaot-mut"));
  const hs = new Headers({ "X-Tsaot-Ctor": "one" });
  hs.append("x-tsaot-ctor", "two");
  console.log(hs.get("X-Tsaot-Ctor") === "one, two");
  let ctorEntriesOk = false;
  for (const [k, v] of (hs as any)) {
    if (k === "x-tsaot-ctor" && v === "one, two") ctorEntriesOk = true;
  }
  console.log(ctorEntriesOk);
  const t = await r.text();
  console.log(typeof t === "string");
}
main();
TS

# 1. compile + link (always): proves the libcurl transport builds & links.
if ! (cd exporter && node exporter.js "$tmp/fetch.ts" "$tmp/f.json" "$tmp/fl.json") 2>"$tmp/exp.err"; then
  echo "[fetch] FAIL: export error"; cat "$tmp/exp.err"; exit 1
fi
if ! "$BIN" "$tmp/f.json" emit > "$tmp/f.c" 2>"$tmp/emit.err"; then
  echo "[fetch] FAIL: emit error"; cat "$tmp/emit.err"; exit 1
fi
link_generated "$tmp/f.c" "$tmp/f" "$tmp/cc.err" "[fetch] FAIL: link error (libcurl?)"
echo "[fetch] PASS: HTTPS fetch program compiles and links against libcurl"

# 2. live request (opt-in via TSAOT_NET=1): allowlisted host only.
if [ "${TSAOT_NET:-0}" = "1" ]; then
  out="$("$tmp/f" 2>&1)"
  if [ "$out" = "$(printf 'true\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue')" ]; then
    echo "[fetch] PASS: live HTTPS request succeeded"
  else
    echo "[fetch] FAIL: live HTTPS request, got: $out"; rc=1
  fi
else
  echo "[fetch] (live request skipped; set TSAOT_NET=1 to enable)"
fi

# 3. Headers constructor/prototype method values (always, network-independent).
cat > "$tmp/headers_methods.ts" <<'TS'
function main(): void {
  const h = new Headers({ "X-Tsaot-Value": "one" });
  const get = h.get;
  console.log(typeof get === "function");
  console.log(get.call(h, "x-tsaot-value") === "one");
  try {
    Headers.prototype.get.call({} as any, "x");
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
  }
  try {
    get("x");
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
  }
  const append = Headers.prototype.append;
  append.call(h, "X-Tsaot-Value", "two");
  console.log(Headers.prototype.get.call(h, "X-Tsaot-Value") === "one, two");
  const has = h.has.bind(h);
  console.log(has("x-tsaot-value"));
  let entryOk = false;
  for (const [k, v] of (Headers.prototype.entries.call(h) as any)) {
    if (k === "x-tsaot-value" && v === "one, two") entryOk = true;
  }
  console.log(entryOk);
}
main();
TS
if ! (cd exporter && node exporter.js "$tmp/headers_methods.ts" "$tmp/hm.json" "$tmp/hml.json") 2>"$tmp/hmexp.err"; then
  echo "[fetch] FAIL: Headers method-value export error"; cat "$tmp/hmexp.err"; exit 1
fi
if ! "$BIN" "$tmp/hm.json" emit > "$tmp/hm.c" 2>"$tmp/hmemit.err"; then
  echo "[fetch] FAIL: Headers method-value emit error"; cat "$tmp/hmemit.err"; exit 1
fi
link_generated "$tmp/hm.c" "$tmp/hm" "$tmp/hmcc.err" "[fetch] FAIL: Headers method-value link error"
hmout="$("$tmp/hm" 2>&1)"
if [ "$hmout" = "$(printf 'true\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue')" ]; then
  echo "[fetch] PASS: Headers constructor/prototype method values work"
else
  echo "[fetch] FAIL: Headers method-value run mismatch, got: $hmout"; rc=1
fi

# 4. Network/setup errors reject the fetch promise (always, network-independent).
cat > "$tmp/fetch_error.ts" <<'TS'
async function main(): Promise<void> {
  try {
    await fetch("http://nonexistent.invalid./", { timeoutMs: 1 } as any);   // a transport failure (the resolve), not a URL parse error
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "TypeError");
    console.log(typeof e.message === "string");
    console.log(e.message.indexOf("fetch failed") >= 0);
  }
}
main();
TS
if ! (cd exporter && node exporter.js "$tmp/fetch_error.ts" "$tmp/fe.json" "$tmp/fel.json") 2>"$tmp/feexp.err"; then
  echo "[fetch] FAIL: fetch error export error"; cat "$tmp/feexp.err"; exit 1
fi
if ! "$BIN" "$tmp/fe.json" emit > "$tmp/fe.c" 2>"$tmp/feemit.err"; then
  echo "[fetch] FAIL: fetch error emit error"; cat "$tmp/feemit.err"; exit 1
fi
link_generated "$tmp/fe.c" "$tmp/fe" "$tmp/fecc.err" "[fetch] FAIL: fetch error link error"
feout="$("$tmp/fe" 2>&1)"
if [ "$feout" = "$(printf 'true\ntrue\ntrue')" ]; then
  echo "[fetch] PASS: fetch network/setup errors reject"
else
  echo "[fetch] FAIL: fetch error run mismatch, got: $feout"; rc=1
fi

# 5. AbortController / AbortSignal start/queued-abort rejection (always,
#    network-independent).
cat > "$tmp/fetch_abort.ts" <<'TS'
async function main(): Promise<void> {
  const ac = new AbortController();
  console.log(ac.signal.aborted === false);
  console.log((ac.signal as any).reason === undefined);
  ac.abort();
  console.log(ac.signal.aborted === true);
  console.log((ac.signal as any).reason.name === "AbortError");
  console.log((ac.signal as any).reason.message === "fetch aborted");
  try {
    await fetch("https://example.invalid/", { signal: ac.signal } as any);
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "AbortError");
    console.log(e.message === "fetch aborted");
  }
  const qc = new AbortController();
  const queued = fetch("https://example.invalid/", { signal: qc.signal } as any);
  qc.abort();
  try {
    await queued;
    console.log(false);
  } catch (e: any) {
    console.log(e.name === "AbortError");
    console.log(e.message === "fetch aborted");
  }
  const rc = new AbortController();
  rc.abort("custom reason");
  try {
    await fetch("https://example.invalid/", { signal: rc.signal } as any);
    console.log(false);
  } catch (e: any) {
    console.log(e === "custom reason");
    console.log((rc.signal as any).reason === "custom reason");
  }
  const tsig = AbortSignal.timeout(0);
  console.log(tsig.aborted === false);
  try {
    await fetch("https://example.invalid/", { signal: tsig } as any);
    console.log(false);
  } catch (e: any) {
    console.log(tsig.aborted === true);
    console.log((tsig as any).reason.name === "TimeoutError");
    console.log(e.name === "TimeoutError");
    console.log(e.message === "signal timed out");
  }
}
main();
TS
if ! (cd exporter && node exporter.js "$tmp/fetch_abort.ts" "$tmp/fa.json" "$tmp/fal.json") 2>"$tmp/faexp.err"; then
  echo "[fetch] FAIL: fetch abort export error"; cat "$tmp/faexp.err"; exit 1
fi
if ! "$BIN" "$tmp/fa.json" emit > "$tmp/fa.c" 2>"$tmp/faemit.err"; then
  echo "[fetch] FAIL: fetch abort emit error"; cat "$tmp/faemit.err"; exit 1
fi
link_generated "$tmp/fa.c" "$tmp/fa" "$tmp/facc.err" "[fetch] FAIL: fetch abort link error"
faout="$("$tmp/fa" 2>&1)"
if [ "$faout" = "$(printf 'true\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue\ntrue')" ]; then
  echo "[fetch] PASS: AbortController start/queued/custom/timeout abort rejects fetch"
else
  echo "[fetch] FAIL: fetch abort run mismatch, got: $faout"; rc=1
fi

# 6. POST/options compile + link (always): covers method/header/body lowering
#    without requiring localhost bind.
cat > "$tmp/post.ts" <<'TS'
async function main(): Promise<void> {
  const hs = new Headers({ "Content-Type": "application/json", "X-Tsaot-Test": "marker123" });
  const opts: any = {
    method: "POST",
    headers: hs,
    body: "{\"hello\":\"world\"}",
    timeoutMs: 30000
  };
  const r = await fetch("http://127.0.0.1:8795/echo", opts);
  console.log(r.status);
  console.log(await r.text());
}
TS
if ! (cd exporter && node exporter.js "$tmp/post.ts" "$tmp/p.json" "$tmp/pl.json") 2>"$tmp/pexp.err"; then
  echo "[fetch] FAIL: POST export error"; cat "$tmp/pexp.err"; exit 1
fi
if ! "$BIN" "$tmp/p.json" emit > "$tmp/p.c" 2>"$tmp/pemit.err"; then
  echo "[fetch] FAIL: POST emit error"; cat "$tmp/pemit.err"; exit 1
fi
link_generated "$tmp/p.c" "$tmp/p" "$tmp/pcc.err" "[fetch] FAIL: POST program link error"
echo "[fetch] PASS: POST/options fetch program compiles and links against libcurl"

# 7. POST + headers + body against a LOCAL echo server. This uses localhost bind,
#    which some sandboxes forbid.
local_mode="${TSAOT_FETCH_LOCAL:-0}"
if [ "$local_mode" = "0" ]; then
  echo "[fetch] (POST echo execution skipped; set TSAOT_FETCH_LOCAL=auto or 1 to enable)"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$tmp" <<'PY' >"$tmp/local.out" 2>"$tmp/local.err" &
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def _echo(self):
        l=int(self.headers.get('Content-Length',0)); body=self.rfile.read(l) if l else b''
        out={'m':self.command,'ct':self.headers.get('Content-Type'),
             'xt':self.headers.get('X-Tsaot-Test'),'body':body.decode()}
        b=json.dumps(out,sort_keys=True).encode()
        self.send_response(200); self.send_header('Content-Length',str(len(b))); self.end_headers(); self.wfile.write(b)
    do_POST=_echo; do_GET=_echo
    def log_message(self,*a): pass
class S(http.server.HTTPServer):
    allow_reuse_address = True
S(('127.0.0.1',8795),H).serve_forever()
PY
  srvpid=$!
  sleep 1
  if kill -0 "$srvpid" 2>/dev/null; then
    pout="$(NO_PROXY=127.0.0.1 no_proxy=127.0.0.1 "$tmp/p" 2>&1)"
    # expect: 200, then the echoed JSON with our method/header/body
    if printf '%s' "$pout" | grep -q '"m": "POST"' \
       && printf '%s' "$pout" | grep -q '"xt": "marker123"' \
       && printf '%s' "$pout" | grep -q '"body": "{\\"hello\\":\\"world\\"}"' \
       && printf '%s' "$pout" | grep -q '^200'; then
      echo "[fetch] PASS: POST with custom headers and body transmitted correctly"
    else
      echo "[fetch] FAIL: POST echo mismatch, got: $pout"; rc=1
    fi
    kill $srvpid 2>/dev/null
  else
    if [ "$local_mode" = "auto" ]; then
      echo "[fetch] (POST echo test skipped; localhost bind unavailable)"
      if [ "${TSAOT_FETCH_LOCAL_VERBOSE:-0}" = "1" ]; then cat "$tmp/local.err"; fi
    else
      echo "[fetch] FAIL: POST echo server did not start"
      cat "$tmp/local.err"
      rc=1
    fi
  fi
else
  echo "[fetch] (POST echo test skipped; python3 not found)"
fi
exit $rc
