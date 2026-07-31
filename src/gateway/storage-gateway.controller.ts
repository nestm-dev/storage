import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Head,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Put,
  Query,
  Req,
  Res,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { StorageError, StorageErrorCode } from '../storage.error.js';
import { StorageService } from '../storage.service.js';
import type {
  StorageByteRange,
  StorageObject,
  StorageObjectMetadata,
  StorageSignedDownloadOptions,
  StorageSignedUploadOptions,
} from '../storage.types.js';
import { StorageGatewayGuard } from './storage-gateway.guard.js';
import { FASTIFY_STORAGE_UPLOAD_CONFIG } from './storage-gateway-fastify-parser.js';
import { STORAGE_GATEWAY_OPTIONS } from './storage-gateway.tokens.js';
import {
  StorageGatewayOperation,
  type ResolvedStorageGatewayOptions,
  type StorageGatewayOperation as StorageGatewayOperationName,
} from './storage-gateway.types.js';

interface ResponseEnvelope<Result> {
  data: Result;
}

interface ResponseWrapper {
  raw?: unknown;
  hijack?: () => void;
}

interface RequestWrapper {
  raw?: unknown;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string.`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a finite number.`);
  }
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = optionalNumber(record, field);
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new BadRequestException(`${field} must be a positive safe integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = optionalNumber(record, field);
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new BadRequestException(
      `${field} must be a non-negative safe integer.`,
    );
  }
  return value;
}

function queryInteger(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[0-9]+$/u.test(value)) {
    throw new BadRequestException(`${field} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException(`${field} must be a safe integer.`);
  }
  return parsed;
}

function rawResponseOf(response: unknown): ServerResponse {
  if (response instanceof ServerResponse) {
    return response;
  }
  if (typeof response === 'object' && response !== null) {
    const wrapper = response as ResponseWrapper;
    wrapper.hijack?.();
    if (wrapper.raw instanceof ServerResponse) {
      return wrapper.raw;
    }
  }
  throw new Error('Unsupported Nest HTTP response adapter.');
}

function requestWrapperOf(request: unknown): RequestWrapper {
  if (typeof request !== 'object' || request === null) {
    throw new BadRequestException('Unsupported Nest HTTP request adapter.');
  }
  return request as RequestWrapper;
}

function requestHeader(request: unknown, name: string): string | undefined {
  const headers = requestWrapperOf(request).headers;
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function uploadSourceOf(request: unknown): Readable {
  const wrapper = requestWrapperOf(request);
  if (wrapper.body instanceof Readable) {
    return wrapper.body;
  }
  if (wrapper.body instanceof Uint8Array) {
    return Readable.from([wrapper.body]);
  }
  if (request instanceof Readable && !request.readableEnded) {
    return request;
  }
  if (wrapper.raw instanceof Readable && !wrapper.raw.readableEnded) {
    return wrapper.raw;
  }
  throw new BadRequestException(
    'Proxy uploads require an application/octet-stream request body.',
  );
}

async function* enforceUploadLimit(
  source: Readable,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of source) {
    const bytes =
      typeof chunk === 'string'
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : undefined;
    if (bytes === undefined) {
      throw new BadRequestException(
        'Upload streams must contain byte or string chunks.',
      );
    }
    received += bytes.byteLength;
    if (received > maxBytes) {
      throw new StorageError(
        `Proxy upload exceeds the ${maxBytes}-byte gateway limit.`,
        {
          code: StorageErrorCode.LIMIT_EXCEEDED,
          permanent: true,
        },
      );
    }
    yield bytes;
  }
}

function setObjectHeaders(
  response: ServerResponse,
  object: StorageObject | StorageObjectMetadata,
): void {
  response.setHeader('content-length', String(object.size));
  response.setHeader('content-type', object.contentType);
  if (object.etag !== undefined) {
    response.setHeader('etag', object.etag);
  }
  if (object.lastModified !== undefined) {
    response.setHeader('last-modified', object.lastModified.toUTCString());
  }
}

const publicStorageMessages: Record<StorageErrorCode, string> = {
  [StorageErrorCode.NOT_FOUND]: 'Storage object was not found.',
  [StorageErrorCode.UNAUTHORIZED]: 'Storage operation is not permitted.',
  [StorageErrorCode.CONFLICT]: 'Storage object conflict.',
  [StorageErrorCode.READ_ONLY]: 'Storage operation is not permitted.',
  [StorageErrorCode.INVALID_ARGUMENT]: 'Invalid storage request.',
  [StorageErrorCode.NOT_SUPPORTED]: 'Storage operation is not supported.',
  [StorageErrorCode.ABORTED]: 'Storage operation was aborted.',
  [StorageErrorCode.TIMEOUT]: 'Storage operation timed out.',
  [StorageErrorCode.LIMIT_EXCEEDED]: 'Storage request limit exceeded.',
  [StorageErrorCode.PROVIDER]: 'Storage provider operation failed.',
};

function storageHttpStatus(error: StorageError): number {
  switch (error.code) {
    case StorageErrorCode.NOT_FOUND:
      return HttpStatus.NOT_FOUND;
    case StorageErrorCode.UNAUTHORIZED:
    case StorageErrorCode.READ_ONLY:
      return HttpStatus.FORBIDDEN;
    case StorageErrorCode.CONFLICT:
      return HttpStatus.CONFLICT;
    case StorageErrorCode.INVALID_ARGUMENT:
      return HttpStatus.BAD_REQUEST;
    case StorageErrorCode.NOT_SUPPORTED:
      return HttpStatus.NOT_IMPLEMENTED;
    case StorageErrorCode.LIMIT_EXCEEDED:
      return HttpStatus.PAYLOAD_TOO_LARGE;
    case StorageErrorCode.ABORTED:
      return HttpStatus.REQUEST_TIMEOUT;
    case StorageErrorCode.TIMEOUT:
      return HttpStatus.GATEWAY_TIMEOUT;
    case StorageErrorCode.PROVIDER:
      return HttpStatus.BAD_GATEWAY;
  }
}

function toHttpException(error: unknown): HttpException {
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof StorageError) {
    return new HttpException(
      {
        error: {
          code: error.code,
          message: publicStorageMessages[error.code],
        },
      },
      storageHttpStatus(error),
      { cause: error },
    );
  }
  return new HttpException(
    {
      error: {
        code: StorageErrorCode.PROVIDER,
        message: 'Storage gateway operation failed.',
      },
    },
    HttpStatus.BAD_GATEWAY,
    { cause: error },
  );
}

@Controller('storage')
@UseGuards(StorageGatewayGuard)
export class StorageGatewayController {
  constructor(
    private readonly storage: StorageService,
    @Inject(STORAGE_GATEWAY_OPTIONS)
    private readonly options: ResolvedStorageGatewayOptions,
  ) {}

  @Get('object')
  async download(
    @Query('key') key: string | undefined,
    @Query('proxy') proxy: string | undefined,
    @Query('rangeStart') rangeStart: string | undefined,
    @Query('rangeEnd') rangeEnd: string | undefined,
    @Query('disposition') disposition: string | undefined,
    @Res() response: unknown,
  ): Promise<void> {
    await this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.DOWNLOAD);
      const objectKey = this.#key(key);
      const client = this.storage.use(this.options.store);
      const forceProxy = proxy === 'true' || proxy === '1';
      const canSign =
        this.options.operations.has(StorageGatewayOperation.SIGN_DOWNLOAD) &&
        client.capabilities.signedDownload.supported;

      if (!forceProxy && this.options.mode !== 'proxy' && canSign) {
        try {
          const url = await client.signDownload(objectKey, {
            expiresIn: this.options.defaultSignedUrlExpiresIn,
            ...(disposition !== undefined && {
              responseContentDisposition: disposition,
            }),
          });
          const raw = rawResponseOf(response);
          raw.statusCode = HttpStatus.TEMPORARY_REDIRECT;
          raw.setHeader('location', url);
          raw.end();
          return;
        } catch (error) {
          if (
            this.options.mode !== 'hybrid' ||
            !(error instanceof StorageError) ||
            error.code !== StorageErrorCode.NOT_SUPPORTED
          ) {
            throw error;
          }
        }
      }

      if (this.options.mode === 'signed') {
        throw new StorageError(
          'Signed downloads are unavailable for this store.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            key: objectKey,
            permanent: true,
          },
        );
      }

      const start = queryInteger(rangeStart, 'rangeStart');
      const end = queryInteger(rangeEnd, 'rangeEnd');
      if (end !== undefined && start === undefined) {
        throw new BadRequestException(
          'rangeStart is required when rangeEnd is provided.',
        );
      }
      const range: StorageByteRange | undefined =
        start === undefined
          ? undefined
          : { start, ...(end !== undefined && { end }) };
      const object = await client.downloadStream(objectKey, {
        ...(range !== undefined && { range }),
      });
      const raw = rawResponseOf(response);
      raw.statusCode =
        range === undefined ? HttpStatus.OK : HttpStatus.PARTIAL_CONTENT;
      setObjectHeaders(raw, object);
      const baseContentType = object.contentType
        .split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      raw.setHeader(
        'content-disposition',
        baseContentType !== undefined &&
          this.options.proxyInlineContentTypes.has(baseContentType)
          ? 'inline'
          : 'attachment',
      );
      raw.setHeader('x-content-type-options', 'nosniff');
      if (range !== undefined) {
        raw.setHeader(
          'content-range',
          `bytes ${range.start}-${range.start + object.size - 1}/*`,
        );
      }
      if (client.capabilities.rangeRead) {
        raw.setHeader('accept-ranges', 'bytes');
      }

      try {
        await pipeline(
          Readable.fromWeb(
            object.body as unknown as NodeReadableStream<Uint8Array>,
          ),
          raw,
        );
      } catch (error) {
        if (raw.headersSent) {
          raw.destroy(error instanceof Error ? error : undefined);
          return;
        }
        throw error;
      }
    });
  }

  @SetMetadata('__fastify_route_config__', {
    [FASTIFY_STORAGE_UPLOAD_CONFIG]: true,
  })
  @Put('object')
  async upload(
    @Query('key') key: string | undefined,
    @Req() request: unknown,
  ): Promise<ResponseEnvelope<unknown>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.UPLOAD);
      if (this.options.mode === 'signed') {
        throw new StorageError(
          'Proxy uploads are disabled in signed gateway mode.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            permanent: true,
          },
        );
      }
      const objectKey = this.#key(key);
      const transportContentType = requestHeader(request, 'content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (transportContentType !== 'application/octet-stream') {
        throw new BadRequestException(
          'Proxy uploads require Content-Type: application/octet-stream.',
        );
      }
      const lengthHeader = requestHeader(request, 'content-length');
      const contentLength =
        lengthHeader === undefined
          ? undefined
          : queryInteger(lengthHeader, 'content-length');
      if (
        contentLength !== undefined &&
        contentLength > this.options.maxUploadBytes
      ) {
        throw new StorageError(
          `Proxy upload exceeds the ${this.options.maxUploadBytes}-byte gateway limit.`,
          {
            code: StorageErrorCode.LIMIT_EXCEEDED,
            key: objectKey,
            permanent: true,
          },
        );
      }
      const source = uploadSourceOf(request);
      const body = Readable.toWeb(
        Readable.from(enforceUploadLimit(source, this.options.maxUploadBytes)),
      ) as ReadableStream<Uint8Array>;
      const contentType =
        requestHeader(request, 'x-storage-content-type') ??
        'application/octet-stream';
      const result = await this.storage
        .use(this.options.store)
        .upload(objectKey, body, { contentType, multipart: true });
      return { data: result };
    });
  }

  @Head('metadata')
  async head(
    @Query('key') key: string | undefined,
    @Res() response: unknown,
  ): Promise<void> {
    await this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.HEAD);
      const metadata = await this.storage
        .use(this.options.store)
        .head(this.#key(key));
      const raw = rawResponseOf(response);
      raw.statusCode = HttpStatus.OK;
      setObjectHeaders(raw, metadata);
      raw.end();
    });
  }

  @Delete('object')
  async delete(
    @Query('key') key: string | undefined,
  ): Promise<ResponseEnvelope<{ deleted: true }>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.DELETE);
      await this.storage.use(this.options.store).delete(this.#key(key));
      return { data: { deleted: true } };
    });
  }

  @Get('list')
  async list(
    @Query('prefix') prefix: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('delimiter') delimiter: string | undefined,
  ): Promise<ResponseEnvelope<unknown>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.LIST);
      const parsedLimit =
        queryInteger(limit, 'limit') ?? this.options.maxListResults;
      if (parsedLimit === 0 || parsedLimit > this.options.maxListResults) {
        throw new BadRequestException(
          `limit must be between 1 and ${this.options.maxListResults}.`,
        );
      }
      const result = await this.storage.use(this.options.store).list({
        ...(cursor !== undefined && { cursor }),
        ...(delimiter !== undefined && { delimiter }),
        limit: parsedLimit,
        ...(prefix !== undefined && { prefix }),
      });
      return { data: result };
    });
  }

  @Get('search')
  async search(
    @Query('pattern') pattern: string | undefined,
    @Query('prefix') prefix: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('maxResults') maxResults: string | undefined,
    @Query('match') match: string | undefined,
    @Query('caseInsensitive') caseInsensitive: string | undefined,
  ): Promise<ResponseEnvelope<unknown>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.SEARCH);
      const searchPattern = this.#key(pattern, 'pattern');
      if (
        match !== undefined &&
        !['glob', 'regex', 'substring', 'exact'].includes(match)
      ) {
        throw new BadRequestException('Invalid search match mode.');
      }
      const parsedLimit =
        limit === undefined ? undefined : queryInteger(limit, 'limit');
      if (
        parsedLimit !== undefined &&
        (parsedLimit === 0 || parsedLimit > this.options.maxSearchResults)
      ) {
        throw new BadRequestException(
          `limit must be between 1 and ${this.options.maxSearchResults}.`,
        );
      }
      const parsedMaxResults =
        queryInteger(maxResults, 'maxResults') ?? this.options.maxSearchResults;
      if (
        parsedMaxResults === 0 ||
        parsedMaxResults > this.options.maxSearchResults
      ) {
        throw new BadRequestException(
          `maxResults must be between 1 and ${this.options.maxSearchResults}.`,
        );
      }
      const objects: StorageObjectMetadata[] = [];
      for await (const object of this.storage
        .use(this.options.store)
        .search(searchPattern, {
          ...(caseInsensitive !== undefined && {
            caseInsensitive:
              caseInsensitive === 'true' || caseInsensitive === '1',
          }),
          ...(parsedLimit !== undefined && { limit: parsedLimit }),
          ...(match !== undefined && {
            match: match as 'glob' | 'regex' | 'substring' | 'exact',
          }),
          maxResults: parsedMaxResults,
          ...(prefix !== undefined && { prefix }),
        })) {
        objects.push(object);
        if (objects.length === parsedMaxResults) {
          break;
        }
      }
      return { data: objects };
    });
  }

  @Post('sign-download')
  async signDownload(
    @Body() body: unknown,
  ): Promise<ResponseEnvelope<{ url: string }>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.SIGN_DOWNLOAD);
      if (this.options.mode === 'proxy') {
        throw new StorageError(
          'Signed downloads are disabled in proxy gateway mode.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            permanent: true,
          },
        );
      }
      const input = recordOf(body, 'body');
      const responseContentDisposition = optionalString(
        input,
        'responseContentDisposition',
      );
      const options: StorageSignedDownloadOptions = {
        expiresIn:
          optionalPositiveInteger(input, 'expiresIn') ??
          this.options.defaultSignedUrlExpiresIn,
        ...(responseContentDisposition !== undefined && {
          responseContentDisposition,
        }),
      };
      const url = await this.storage
        .use(this.options.store)
        .signDownload(requiredString(input, 'key'), options);
      return { data: { url } };
    });
  }

  @Post('sign-upload')
  async signUpload(@Body() body: unknown): Promise<ResponseEnvelope<unknown>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.SIGN_UPLOAD);
      if (this.options.mode === 'proxy') {
        throw new StorageError(
          'Signed uploads are disabled in proxy gateway mode.',
          {
            code: StorageErrorCode.NOT_SUPPORTED,
            permanent: true,
          },
        );
      }
      const input = recordOf(body, 'body');
      const contentType = optionalString(input, 'contentType');
      const maxSize = optionalPositiveInteger(input, 'maxSize');
      const minSize = optionalNonNegativeInteger(input, 'minSize');
      if (maxSize !== undefined && minSize !== undefined && minSize > maxSize) {
        throw new BadRequestException(
          'minSize cannot be greater than maxSize.',
        );
      }
      const options: StorageSignedUploadOptions = {
        expiresIn:
          optionalPositiveInteger(input, 'expiresIn') ??
          this.options.defaultSignedUrlExpiresIn,
        ...(contentType !== undefined && { contentType }),
        ...(maxSize !== undefined && { maxSize }),
        ...(minSize !== undefined && { minSize }),
      };
      const result = await this.storage
        .use(this.options.store)
        .signUpload(requiredString(input, 'key'), options);
      return { data: result };
    });
  }

  @Post('copy')
  async copy(
    @Body() body: unknown,
  ): Promise<ResponseEnvelope<{ copied: true }>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.COPY);
      const input = recordOf(body, 'body');
      await this.storage
        .use(this.options.store)
        .copy(requiredString(input, 'from'), requiredString(input, 'to'));
      return { data: { copied: true } };
    });
  }

  @Post('move')
  async move(
    @Body() body: unknown,
  ): Promise<ResponseEnvelope<{ moved: true }>> {
    return this.#run(async () => {
      this.#assertAllowed(StorageGatewayOperation.MOVE);
      const input = recordOf(body, 'body');
      await this.storage
        .use(this.options.store)
        .move(requiredString(input, 'from'), requiredString(input, 'to'));
      return { data: { moved: true } };
    });
  }

  #assertAllowed(operation: StorageGatewayOperationName): void {
    if (!this.options.operations.has(operation)) {
      throw new HttpException(
        {
          error: {
            code: 'OPERATION_NOT_ALLOWED',
            message: `Storage gateway operation "${operation}" is disabled.`,
          },
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }

  #key(value: string | undefined, label = 'key'): string {
    if (value === undefined || value.length === 0) {
      throw new BadRequestException(`${label} is required.`);
    }
    return value;
  }

  async #run<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      throw toHttpException(error);
    }
  }
}
