export class Widget { constructor(public id: number) {} label() { return "W" + this.id; } }
export enum Mode { Off, On = 9 }
export const VERSION = "1.0";
