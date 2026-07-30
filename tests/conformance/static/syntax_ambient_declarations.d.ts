export as namespace GarnetSyntax;

export interface PublicShape {
  readonly id: string;
}

export default function createShape(id: string): PublicShape;

import LegacyImport = require("garnet:legacy");
export { LegacyImport };

declare global {
  interface GlobalShape {
    enabled: boolean;
  }
}

declare module "garnet:virtual" {
  export interface VirtualValue {
    value: number;
  }
  export const virtualValue: VirtualValue;
}

declare module "garnet:legacy" {
  const legacyValue: { value: number };
  export = legacyValue;
}
