import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isObservable, lastValueFrom } from 'rxjs';

import { STORAGE_GATEWAY_GUARDS } from './storage-gateway.tokens.js';

@Injectable()
export class StorageGatewayGuard implements CanActivate {
  constructor(
    @Inject(STORAGE_GATEWAY_GUARDS)
    private readonly guards: readonly CanActivate[],
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    for (const guard of this.guards) {
      const result = guard.canActivate(context);
      const allowed = isObservable(result)
        ? await lastValueFrom(result)
        : await result;
      if (!allowed) {
        return false;
      }
    }
    return true;
  }
}
