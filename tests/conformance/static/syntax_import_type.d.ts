export type Imported = import(
  "./import_type_dependency",
  { with: { "resolution-mode": "import" } }
).ImportedShape;

export declare const imported: Imported;
