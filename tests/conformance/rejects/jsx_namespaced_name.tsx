declare namespace JSX {
  interface IntrinsicElements {
    [name: string]: unknown;
  }
}

const element = <svg:path stroke-width="2" />;
console.log(element);
