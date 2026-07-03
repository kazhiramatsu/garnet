# garnet — Claude Code 作業ガイド

**garnet** は TypeScript → C の AOT コンパイラ（旧名 tsaot。TypeScript 製・自己ホスティングを目標）。
日本語ユーザー Kaz のプロジェクト。**応答は日本語で**。

> 注: コード内部の識別子・cargo バイナリ名は今も `tsaot`（改名は blast radius が大きいため保留中）。
> 明示の指示なくソースの `tsaot` を一括置換しないこと。

## 作業開始時に必ず読む順番
1. **`docs/TODO.md` の末尾**（セッション番号順）— ここが**進捗の唯一の真の情報源**。まず tail を読んで現状を把握する。
2. 初回・セットアップ未了なら `CLAUDE_CODE_HANDOFF.md`（セットアップ手順・ワークフロー詳細）。

## 進捗の記録ルール
- **進捗ログは `docs/TODO.md` 末尾に追記して蓄積する。メモリ(MEMORY.md)には進捗を保存しない**
  （メモリに入れると肥大化・陳腐化してコンテキストを汚す。repo が記録すべきは repo に置く）。
- 完了したセッションの要約は TODO.md に番号付きで追記。

## 規律
- **V8 差分でバグを 1 件ずつ潰す**。`scripts/difftest.sh` を source して `dt "name" 'function main(){...}main();'`、
  または `build/diff.sh` の `diff`。garnet のネイティブ出力を node(=V8) と比較。
- **silent miscompile（黙って誤値）を最優先**で潰す。reject は loud（コンパイル時 or catch 可能な throw）に。黙って無視は不可。
- **perf 回帰ゼロ**を保つ。ホットパスに分岐/コストを足さない（足すなら単一予測分岐で gate）。
- 完了基準: **conformance 全緑 + ci_fast/unit + bench(perf budget) + bundler 全緑**。新機能は conformance に最小テストを追加。

## 構成
- `exporter/` … TS→IR。大半のロジックはここ。
- `analyzer_ts/` … **TS 製 analyzer（セルフホスト版）。§303 以降の開発主体はこちら**。
  devirt / interproc(escape) / emit(boxed) 移植済み。`scripts/analyzer_conformance.sh` と
  `scripts/analyzer_difftest.sh`（スモーク）、fixpoint/diffall が回帰ゲート。
- `analyzer/` … Rust。**凍結＝差分オラクル**（cargo binary 名は `tsaot`）。新機能はまず analyzer_ts に実装し、
  Rust 側は検証に必要な場合のみ追随（ダンプモード追加等）。
- `runtime/ts_rt.c` … ランタイム。
- emit_c … IR→C（Rust 版。TS 版は `analyzer_ts/src/emit.ts`）。

## セルフホスト開発の方針（ユーザー指示・セッション303〜）
- **新規開発は analyzer_ts（TS）で行う**。Rust analyzer はオラクルとして維持し、原則改変しない。
- 検証は「パスダンプ byte 比較」（devirt/escape モード）+ conformance + スモーク + diffall + fixpoint。
- analyzer_ts のソースは **garnet 自身でコンパイル可能に保つ**（exporter の制限: for-of 内 continue 不可等）。
  native 化は `TSAOT_UNTYPED=1 ./garnet analyzer_ts/src/selfhost.ts`。

## 横断的な教訓（code から自明でなく毎回刺さるもの）
- **TS/ESM は常に strict**。sloppy 挙動（frozen への書き込み無視等）は silent miscompile。オラクルを実行系と同じ module 形式(ESM)にすると隠れた意味論ズレが顕在化する。
- **whole-program AOT は本質的にバンドル指向**。`ts.Symbol` キーイング + checker の alias 解決で module linking がほぼ無料。
- **IR struct（Local/ClassDef 等）に新フィールドを足したら、`analyzer/.../sroa.rs` の構築箇所と `tests/*.rs` のリテラル4ファイルも必ず更新する**。
- **GC: allocate する関数は live な tsv 引数を必ず root する**（clone/new の前後で root/unroot）。GC-stress probe で確認。
- **ループ変数を closure がキャプチャするとき、変数書き込みは必ず capture cell 経由（StoreField VALUE）**。生ローカル直書きは cell をバイパスして undefined になる。
- **型駆動最適化(unbox/SROA)は値を落としやすい**。`never`/conditional 型・per-body 処理（配列 SROA は whole-function escape を見ない）に注意。安全側に倒す。
- **proto に box するメソッドは g_function_proto 初期化後に作る**（`.call`/`.apply`/`.bind` 解決のため）。
- **METHOD キー vs FIELD キーの名前空間ミスマッチが silent-DIFF の常連**。
- **`ts_to_num` は生ビット再解釈（ToNumber ではない）**。`undefined`→NaN は JS 一致だが `null`→NaN は不一致。
- **新機能のゲートは単一予測分岐で**（例 `if (g_has_proxies && ...)`）＝未使用時ホットパス回帰ゼロ。
- **マシン負荷下でベンチ絶対値は不可信。A/B 直接計測で判断する**。
- **AOT 設計**: ランタイム Environment Record を持たない。ResolveBinding は TS チェッカーのコンパイル時スコープ解決に委譲＝ビルトイン検出は symbol ベース(shadow-aware)。

## 既知の残（低優先・意図的に保留）
- `+`/`-` の int 特化ループ変数が [2^53, 2^63] を跨ぐ稀ケースの精度（V8 は double 丸め）。
- bigint（数値型全体・根本未対応）、Array.prototype monkey-patch（モデル外）。
