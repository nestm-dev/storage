import {
  Injectable,
  UnsupportedMediaTypeException,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Readable } from 'node:stream';

interface FastifyParserInstance {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    parser: (
      request: unknown,
      payload: Readable,
      done: (error: Error | null, body?: unknown) => void,
    ) => void,
  ): void;
}

interface FastifyParserRequest {
  routeOptions?: {
    config?: Record<string, unknown>;
  };
}

export const FASTIFY_STORAGE_UPLOAD_CONFIG = 'nestmStorageGatewayUpload';

function unsupportedMediaType(): Error {
  return new UnsupportedMediaTypeException(
    'Unsupported Media Type: application/octet-stream',
  );
}

function isFastifyParserInstance(
  value: unknown,
): value is FastifyParserInstance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<FastifyParserInstance>;
  return (
    typeof candidate.addContentTypeParser === 'function' &&
    typeof candidate.hasContentTypeParser === 'function'
  );
}

@Injectable()
export class StorageGatewayFastifyParser implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapterHost.httpAdapter.getInstance();
    if (
      !isFastifyParserInstance(instance) ||
      instance.hasContentTypeParser('application/octet-stream')
    ) {
      return;
    }

    instance.addContentTypeParser(
      'application/octet-stream',
      (request, payload, done) => {
        const parserRequest = request as FastifyParserRequest;
        if (
          parserRequest.routeOptions?.config?.[
            FASTIFY_STORAGE_UPLOAD_CONFIG
          ] !== true
        ) {
          done(unsupportedMediaType());
          return;
        }
        done(null, payload);
      },
    );
  }
}
