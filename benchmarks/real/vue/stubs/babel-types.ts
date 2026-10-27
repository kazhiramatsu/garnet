// The @babel/types node types vue's compiler names, from the package's own typings (benchmarks/real/vue/types.txt
// installs them under <clone>/garnet-types): type positions only, no code.
export type {
  Node, Identifier, Expression, Program, Function, BlockStatement, ObjectProperty, ForInStatement, ForOfStatement,
  ForStatement, SwitchCase, SwitchStatement, AssignmentExpression, UpdateExpression,
} from "../garnet-types/node_modules/@babel/types/lib/index";
