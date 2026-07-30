#!/usr/bin/env node
"use strict";

// AST-level guard for the TypeScript syntax corpus. Runtime-supported syntax is
// under tests/conformance; legal-but-unsupported syntax is under
// tests/conformance/rejects; module/JSX grammar is also represented by bundler
// fixtures. This prevents a future "comprehensive" suite from quietly losing an
// entire grammar node or operator family.
const fs = require("fs");
const path = require("path");
const ts = require("../exporter/node_modules/typescript");
const root = path.resolve(__dirname, "..");

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(file, out);
    else if (/(\.tsx?|\.d\.ts)$/.test(entry.name)) out.push(file);
  }
  return out;
}

const files = [
  ...sourceFiles(path.join(root, "tests", "conformance")),
  ...sourceFiles(path.join(root, "tests", "bundler")),
];
const nodes = new Set();
const operators = new Set();
const modifiers = new Set();
let parseErrors = 0;

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const legalityCorpus =
    file.includes(`${path.sep}syntax${path.sep}`) ||
    file.includes(`${path.sep}rejects${path.sep}`) ||
    file.includes(`${path.sep}static${path.sep}`) ||
    file.includes(`${path.sep}bundler${path.sep}`);
  if (legalityCorpus && sf.parseDiagnostics.length) {
    parseErrors += sf.parseDiagnostics.length;
    console.error(`[syntax-coverage] parse error: ${path.relative(root, file)}`);
  }
  const visit = (node) => {
    nodes.add(node.kind);
    if (ts.isBinaryExpression(node)) operators.add(node.operatorToken.kind);
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      operators.add(node.operator);
    }
    for (const modifier of node.modifiers || []) modifiers.add(modifier.kind);
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Source-expressible AST nodes in TypeScript 5.9. Exclusions:
// - SyntheticExpression / MissingDeclaration: parser recovery/transform nodes.
// - WithStatement: the TS compiler diagnoses it; it is not legal TS input.
// - ImportTypeAssertionContainer: legacy internal wrapper; current syntax maps
//   import() attributes directly to ImportAttributes (301).
const excludedNodes = new Set([
  ts.SyntaxKind.SyntheticExpression,
  ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.MissingDeclaration,
  ts.SyntaxKind.ImportTypeAssertionContainer,
]);
const missingNodes = [];
for (let kind = ts.SyntaxKind.FirstNode; kind <= ts.SyntaxKind.SourceFile; kind++) {
  if (!excludedNodes.has(kind) && !nodes.has(kind)) missingNodes.push(kind);
}

const requiredOperators = [
  "PlusToken", "MinusToken", "AsteriskToken", "SlashToken", "PercentToken",
  "AsteriskAsteriskToken", "LessThanLessThanToken", "GreaterThanGreaterThanToken",
  "GreaterThanGreaterThanGreaterThanToken", "AmpersandToken", "BarToken",
  "CaretToken", "AmpersandAmpersandToken", "BarBarToken",
  "QuestionQuestionToken", "LessThanToken", "LessThanEqualsToken",
  "GreaterThanToken", "GreaterThanEqualsToken", "EqualsEqualsToken",
  "ExclamationEqualsToken", "EqualsEqualsEqualsToken",
  "ExclamationEqualsEqualsToken", "InKeyword", "InstanceOfKeyword",
  "EqualsToken", "PlusEqualsToken", "MinusEqualsToken",
  "AsteriskEqualsToken", "SlashEqualsToken", "PercentEqualsToken",
  "AsteriskAsteriskEqualsToken", "LessThanLessThanEqualsToken",
  "GreaterThanGreaterThanEqualsToken", "GreaterThanGreaterThanGreaterThanEqualsToken",
  "AmpersandEqualsToken", "BarEqualsToken", "CaretEqualsToken",
  "AmpersandAmpersandEqualsToken", "BarBarEqualsToken",
  "QuestionQuestionEqualsToken", "CommaToken", "PlusPlusToken",
  "MinusMinusToken", "ExclamationToken", "TildeToken",
].map((name) => ts.SyntaxKind[name]);
const missingOperators = requiredOperators.filter((kind) => !operators.has(kind));

// Literal/primary-expression kinds live in TypeScript's token range rather than
// FirstNode..SourceFile, even though the parser exposes them as AST nodes. Keep
// them explicit so BigInt/RegExp/template/JSX coverage cannot disappear.
const requiredPrimaryKinds = [
  "NumericLiteral", "BigIntLiteral", "StringLiteral", "JsxText",
  "RegularExpressionLiteral", "NoSubstitutionTemplateLiteral",
  "TemplateHead", "TemplateMiddle", "TemplateTail",
  "Identifier", "PrivateIdentifier", "ThisKeyword", "SuperKeyword",
  "TrueKeyword", "FalseKeyword", "NullKeyword", "ImportKeyword",
].map((name) => ts.SyntaxKind[name]);
const missingPrimaryKinds = requiredPrimaryKinds.filter((kind) => !nodes.has(kind));

const requiredModifiers = [
  "ExportKeyword", "DefaultKeyword", "DeclareKeyword", "PublicKeyword",
  "PrivateKeyword", "ProtectedKeyword", "ReadonlyKeyword", "AbstractKeyword",
  "StaticKeyword", "OverrideKeyword", "AsyncKeyword", "ConstKeyword",
  "InKeyword", "OutKeyword", "AccessorKeyword", "Decorators",
];
// Decorators are nodes rather than modifier tokens in TS 5.x.
const missingModifiers = requiredModifiers
  .filter((name) => name !== "Decorators")
  .map((name) => ts.SyntaxKind[name])
  .filter((kind) => !modifiers.has(kind));
if (!nodes.has(ts.SyntaxKind.Decorator)) missingModifiers.push(ts.SyntaxKind.Decorator);

function names(kind) {
  return Object.entries(ts.SyntaxKind)
    .filter(([, value]) => value === kind)
    .map(([name]) => name)
    .join("/");
}
if (missingNodes.length) {
  console.error("[syntax-coverage] missing AST nodes:");
  for (const kind of missingNodes) console.error(`  ${kind} ${names(kind)}`);
}
if (missingOperators.length) {
  console.error("[syntax-coverage] missing operators:");
  for (const kind of missingOperators) console.error(`  ${kind} ${names(kind)}`);
}
if (missingPrimaryKinds.length) {
  console.error("[syntax-coverage] missing literal/primary kinds:");
  for (const kind of missingPrimaryKinds) console.error(`  ${kind} ${names(kind)}`);
}
if (missingModifiers.length) {
  console.error("[syntax-coverage] missing modifiers:");
  for (const kind of missingModifiers) console.error(`  ${kind} ${names(kind)}`);
}

if (parseErrors || missingNodes.length || missingOperators.length ||
    missingPrimaryKinds.length || missingModifiers.length) {
  process.exit(1);
}
console.log(
  `[syntax-coverage] PASS: ${files.length} files, ${nodes.size} AST kinds, ` +
  `${operators.size} operators, ${modifiers.size} modifiers`,
);
