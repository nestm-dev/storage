export interface S3ConstructionMetadata {
  /** Whether URL generation bypasses signing through a configured public origin. */
  readonly publicBaseUrlConfigured: boolean;
}

const constructionMetadata = new WeakMap<
  object,
  Readonly<S3ConstructionMetadata>
>();
const conditionalRequestPermission = new WeakMap<object, boolean>();

export function recordS3ConditionalRequestPermission(
  raw: object,
  enabled: boolean,
): void {
  const existing = conditionalRequestPermission.get(raw);
  if (existing !== undefined && existing !== enabled) {
    throw new TypeError(
      'S3 conditional-request construction permission cannot be changed.',
    );
  }
  conditionalRequestPermission.set(raw, enabled);
}

export function getS3ConditionalRequestPermission(
  raw: object,
): boolean | undefined {
  return conditionalRequestPermission.get(raw);
}

export function recordS3ConstructionMetadata(
  raw: object,
  metadata: S3ConstructionMetadata,
): void {
  const existing = constructionMetadata.get(raw);
  if (
    existing !== undefined &&
    existing.publicBaseUrlConfigured !== metadata.publicBaseUrlConfigured
  ) {
    throw new TypeError('S3 adapter construction metadata cannot be changed.');
  }
  constructionMetadata.set(raw, Object.freeze({ ...metadata }));
}

export function getS3ConstructionMetadata(
  raw: object,
): Readonly<S3ConstructionMetadata> | undefined {
  return constructionMetadata.get(raw);
}
