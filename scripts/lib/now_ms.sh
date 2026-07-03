#!/usr/bin/env bash
# now_ms — サブプロセス起動コストを最小化した ms タイムスタンプ（source して使う）。
#
# 旧実装は計測のたびに python3 -c を起動していた（~16ms/回。gate bench は 1 回の
# 実行で数百起動になり、監視上は python の連続スポーン = 高負荷に見える）。
# 極小 C ヘルパ（初回のみ cc・以後 exec ~1ms）を使い、cc 不可環境は perl に落とす。
#
# 注意: この lib は呼び出し元の ROOT 等の変数を上書きしない（s315 の教訓）。
_tsaot_nowms_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
_tsaot_nowms_bin="$_tsaot_nowms_root/build/now_ms"
if [ ! -x "$_tsaot_nowms_bin" ]; then
  mkdir -p "$_tsaot_nowms_root/build"
  _tsaot_nowms_src="$(mktemp "${TMPDIR:-/tmp}/now_ms.XXXXXX")" && mv "$_tsaot_nowms_src" "$_tsaot_nowms_src.c" && _tsaot_nowms_src="$_tsaot_nowms_src.c"
  cat > "$_tsaot_nowms_src" <<'EOF'
#include <stdio.h>
#include <sys/time.h>
int main(void){
  struct timeval tv; gettimeofday(&tv, 0);
  printf("%lld\n", (long long)tv.tv_sec*1000 + tv.tv_usec/1000);
  return 0;
}
EOF
  # 併走 source と競合しないよう一時名でビルドして原子的に配置
  if cc -O2 "$_tsaot_nowms_src" -o "$_tsaot_nowms_bin.$$" 2>/dev/null; then
    mv -f "$_tsaot_nowms_bin.$$" "$_tsaot_nowms_bin"
  fi
  rm -f "$_tsaot_nowms_src" "$_tsaot_nowms_bin.$$"
fi
if [ -x "$_tsaot_nowms_bin" ]; then
  now_ms(){ "$_tsaot_nowms_bin"; }
else
  now_ms(){ perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }
fi
