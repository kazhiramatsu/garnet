let trace: string[] = [];

function returnThroughNestedTry(): number {
  try {
    try {
      return 1;
    } catch (_error) {
      return 2;
    }
  } finally {
    trace.push("outer-try");
  }
}

function returnThroughNestedCatch(): number {
  try {
    try {
      throw "caught";
    } catch (_error) {
      return 3;
    }
  } finally {
    trace.push("outer-catch");
  }
}

function nestedFinallyOverrides(): number {
  try {
    try {
      return 4;
    } finally {
      trace.push("inner");
    }
  } finally {
    trace.push("outer-finally");
    return 5;
  }
}

console.log(
  returnThroughNestedTry(),
  returnThroughNestedCatch(),
  nestedFinallyOverrides(),
  trace.join(","),
);
