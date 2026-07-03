function concatManySemantics(): void {
  console.log(1 + 2 + "x");
  console.log("x" + 1 + 2);

  const latin = "é";
  const face = "😀";
  const s = "row:" + 12 + ":" + latin + ":" + face;
  console.log(s, s.length, s.charCodeAt(7), s.charCodeAt(9));
}

function concatMarkerInPrefix(N: number): number {
  const prefix = "x:";
  const marker = "x";
  const tail = ":tail";
  let sum = 0;
  let last = "";
  let i = 0;
  while (i < N) {
    const s = prefix + i + ":" + marker + tail;
    last = s;
    sum = sum + s.length + s.charCodeAt(0) + s.charCodeAt(s.length - 1) + s.indexOf(marker);
    i = i + 1;
  }
  return sum + last.indexOf(marker) + last.length;
}

function concatDigitMarker(limit: number): number {
  const prefix = "row:";
  const marker = "1";
  const tail = ":x";
  let sum = 0;
  let last = "";
  let i = 9;
  while (i < limit) {
    const s = prefix + i + ":" + marker + tail;
    last = s;
    sum = sum + s.length + s.charCodeAt(0) + s.charCodeAt(s.length - 1) + s.indexOf(marker);
    i = i + 1;
  }
  return sum + last.indexOf(marker) + last.length;
}

function concatZeroLoop(N: number): string {
  const prefix = "row:";
  const marker = "😀";
  const tail = ":x";
  let sum = 0;
  let last = "seed";
  let i = 0;
  while (i < N) {
    const s = prefix + i + ":" + marker + tail;
    last = s;
    sum = sum + s.length + s.charCodeAt(0) + s.charCodeAt(s.length - 1) + s.indexOf(marker);
    i = i + 1;
  }
  return last + ":" + sum;
}

function polymorphicSearchDefault(N: number): number {
  const s = "ab-cd_ef:gh|ij";
  const p0 = "-";
  const p1 = "_";
  const p2 = ":";
  const p3 = "|";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let pat = p0;
    if (pick === 1) {
      pat = p1;
    } else if (pick === 2) {
      pat = p2;
    } else if (pick === 3) {
      pat = p3;
    }
    sum = sum + s.indexOf(pat);
    sum = sum + s.lastIndexOf(pat);
    pick = pick + 2;
    if (pick >= 5) pick = 0;
    i = i + 1;
  }
  return sum + s.length;
}

function threeWayPatternSelection(N: number): number {
  const s = "ab-cd_ef:gh";
  const p0 = "-";
  const p1 = "_";
  const p2 = ":";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let pat = p0;
    if (pick === 1) {
      pat = p1;
    } else if (pick === 2) {
      pat = p2;
    }
    sum = sum + s.indexOf(pat);
    sum = sum + s.lastIndexOf(pat);
    pick = pick + 1;
    if (pick >= 3) pick = 0;
    i = i + 1;
  }
  return sum + s.length;
}

function replaceDollarFallback(N: number): number {
  const s = "ab-cd_ef:gh|ij";
  const p0 = "-";
  const p1 = "_";
  const p2 = ":";
  const p3 = "|";
  const r0 = "+";
  const r1 = "$&";
  const r2 = ";";
  const r3 = ",";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let pat = p0;
    let rep = r0;
    if (pick === 1) {
      pat = p1;
      rep = r1;
    } else if (pick === 2) {
      pat = p2;
      rep = r2;
    } else if (pick === 3) {
      pat = p3;
      rep = r3;
    }
    const out = s.replaceAll(pat, rep);
    sum = sum + out.length + out.indexOf(rep) + out.charCodeAt(0);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + s.length;
}

function splitEmptyFallback(N: number): number {
  const s = "alpha,beta;gamma:delta";
  const p0 = ",";
  const p1 = "";
  const p2 = ":";
  const p3 = ";";
  const j0 = "|";
  const j1 = "/";
  const j2 = "+";
  const j3 = "=";
  let pick = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    let sep = p0;
    let joiner = j0;
    if (pick === 1) {
      sep = p1;
      joiner = j1;
    } else if (pick === 2) {
      sep = p2;
      joiner = j2;
    } else if (pick === 3) {
      sep = p3;
      joiner = j3;
    }
    const parts = s.split(sep);
    const joined = parts.join(joiner);
    sum = sum + parts.length + joined.length + parts[1].length;
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return sum + s.length;
}

function materializationZeroLoop(N: number): string {
  const csv = "alpha,beta,gamma";
  let sum = 0;
  let last = "seed";
  let i = 0;
  while (i < N) {
    const parts = csv.split(",");
    const joined = parts.join("|");
    last = joined;
    sum = sum + joined.length + joined.charCodeAt(0) + joined.charCodeAt(joined.length - 1);
    i = i + 1;
  }
  return last + ":" + sum;
}

function dynamicMaterializationZeroLoop(N: number): string {
  const s0 = "😀éA|tail";
  const s1 = "B😀é|tail";
  const s2 = "éC😀|tail";
  const s3 = "Dé|😀tail";
  const pat = "😀";
  const rep = "éZ";
  let pick = 0;
  let sum = 0;
  let i = 0;
  let last = "seed";
  while (i < N) {
    let s = s0;
    if (pick === 1) s = s1;
    else if (pick === 2) s = s2;
    else if (pick === 3) s = s3;
    const r = s.replaceAll(pat, rep);
    last = r;
    sum = sum + r.length + r.indexOf(rep) + r.lastIndexOf(rep) + r.charCodeAt((pick * 3) & 7);
    pick = pick + 1;
    if (pick >= 4) pick = 0;
    i = i + 1;
  }
  return last + ":" + sum;
}

function materializedTempUsedAfter(N: number): number {
  const s = "ab-cd-ef";
  let sum = 0;
  let last = "";
  let i = 0;
  while (i < N) {
    const r = s.replaceAll("-", "+");
    last = r;
    sum = sum + r.length + r.indexOf("+") + r.charCodeAt(0);
    const observed = r + "!";
    sum = sum + observed.length + observed.indexOf("+");
    i = i + 1;
  }
  return sum + last.length;
}

function main(): void {
  concatManySemantics();
  console.log(concatMarkerInPrefix(5));
  console.log(concatDigitMarker(13));
  console.log(concatZeroLoop(0));
  console.log(polymorphicSearchDefault(7));
  console.log(threeWayPatternSelection(8));
  console.log(replaceDollarFallback(8));
  console.log(splitEmptyFallback(8));
  console.log(materializationZeroLoop(0));
  console.log(dynamicMaterializationZeroLoop(0));
  console.log(materializedTempUsedAfter(4));
}

main();
