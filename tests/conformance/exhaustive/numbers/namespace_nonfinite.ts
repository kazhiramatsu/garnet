console.log(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN);
console.log(Number.POSITIVE_INFINITY === Infinity, Number.NEGATIVE_INFINITY === -Infinity);
console.log(Number.isNaN(Number.NaN), Number.isFinite(Number.POSITIVE_INFINITY));
const positive = Number.POSITIVE_INFINITY;
const negative = Number.NEGATIVE_INFINITY;
console.log(positive + negative, 1 / positive, Object.is(1 / negative, -0));
