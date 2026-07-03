class Named { label: string; constructor(s: string) { this.label = s; } get(): string { return this.label; } }
let g: Named | null = null;
function make(s: string): Named { const n = new Named(s); g = n; return n; }
function main(): void { console.log(make("hi").get()); }   // hi

main();
