import type {
  CanActivate,
  InjectionToken,
  ModuleMetadata,
} from '@nestjs/common';

export const StorageGatewayOperation = {
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  HEAD: 'head',
  DELETE: 'delete',
  LIST: 'list',
  SEARCH: 'search',
  SIGN_DOWNLOAD: 'signDownload',
  SIGN_UPLOAD: 'signUpload',
  COPY: 'copy',
  MOVE: 'move',
} as const;

export type StorageGatewayOperation =
  (typeof StorageGatewayOperation)[keyof typeof StorageGatewayOperation];

export type StorageGatewayMode = 'proxy' | 'signed' | 'hybrid';

export interface StorageGatewayOptions {
  /**
   * Module exporting StorageService. Required when StorageModule is not global.
   */
  imports?: ModuleMetadata['imports'];
  /** Store used by the gateway. Omit to use StorageService's default. */
  store?: string;
  /** Deny-by-default operation allowlist. Must contain at least one operation. */
  operations: readonly StorageGatewayOperation[];
  /**
   * Existing Nest guard providers. Every guard must allow the request.
   * Registration fails when omitted unless allowUnauthenticated is true.
   */
  guards?: readonly InjectionToken<CanActivate>[];
  /**
   * Explicit development escape hatch. Never enable this on an internet-facing
   * gateway.
   */
  allowUnauthenticated?: boolean;
  /** Defaults to hybrid: prefer signed downloads, proxy when unavailable. */
  mode?: StorageGatewayMode;
  /** Proxy upload ceiling. Defaults to 100 MiB. */
  maxUploadBytes?: number;
  /** Maximum list page size exposed by the gateway. Defaults to 1,000. */
  maxListResults?: number;
  /**
   * Maximum number of search results materialized by one gateway request.
   * Defaults to 1,000.
   */
  maxSearchResults?: number;
  /**
   * Exact MIME types that proxy downloads may render inline. Everything else
   * is served as an attachment. Defaults to an empty allowlist.
   */
  proxyInlineContentTypes?: readonly string[];
  /** Default signed-download lifetime. Defaults to 300 seconds. */
  defaultSignedUrlExpiresIn?: number;
}

export interface ResolvedStorageGatewayOptions {
  store?: string;
  operations: ReadonlySet<StorageGatewayOperation>;
  allowUnauthenticated: boolean;
  mode: StorageGatewayMode;
  maxUploadBytes: number;
  maxListResults: number;
  maxSearchResults: number;
  proxyInlineContentTypes: ReadonlySet<string>;
  defaultSignedUrlExpiresIn: number;
}
