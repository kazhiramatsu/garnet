function Constructor(this: { createdByNew: boolean }): void {
  this.createdByNew = new.target !== undefined;
}

console.log(new (Constructor as any)().createdByNew);
