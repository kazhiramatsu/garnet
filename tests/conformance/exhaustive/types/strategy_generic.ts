type Comparator<T> = (a: T, b: T) => number;
interface Sorter<T> { sort(arr: T[], cmp: Comparator<T>): T[]; }
class BubbleSorter<T> implements Sorter<T> {
  sort(arr: T[], cmp: Comparator<T>): T[] {
    const a = [...arr];
    for (let i = 0; i < a.length; i++) for (let j = 0; j < a.length - 1 - i; j++) if (cmp(a[j], a[j + 1]) > 0) { const t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; }
    return a;
  }
}
const strategies: Record<string, Comparator<number>> = {
  asc: (a, b) => a - b,
  desc: (a, b) => b - a,
};
function main(): void {
  const s = new BubbleSorter<number>();
  console.log(s.sort([3, 1, 2], strategies.asc).join(","));    // 1,2,3
  console.log(s.sort([3, 1, 2], strategies.desc).join(","));   // 3,2,1
  const ss = new BubbleSorter<string>();
  console.log(ss.sort(["banana", "apple", "cherry"], (a, b) => a < b ? -1 : 1).join(",")); // apple,banana,cherry
}
main();
