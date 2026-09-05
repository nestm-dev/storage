import { StorageError } from '../storage.error.js';
import { storageInteger } from '../core/storage-streams.js';
import type { StorageOperationOptions } from '../storage.types.js';
import type {
  StorageWorkspace,
  StorageWorkspacePermission,
} from './storage-workspace.types.js';
import type {
  StorageFileWorkflowCapability,
  StorageFileWorkflowOperation,
  StorageFileWorkflowPermission,
} from './storage-file-workflow.types.js';
import type { StorageFileCatalogCapability } from './storage-file-catalog.types.js';

export interface StorageFileWorkflowProtection {
  readonly signal: AbortSignal;
  /** Fresh host authority check. Transaction ports must independently recheck. */
  readonly authorize: (operation: {
    readonly permission: StorageFileWorkflowPermission;
    readonly signal: AbortSignal;
  }) => void | Promise<void>;
}
export interface StorageFileWorkflowWorkspace<
  Receipt = unknown,
> extends StorageWorkspace {
  readonly workflows: StorageFileWorkflowCapability<Receipt>;
  readonly catalog?: StorageFileCatalogCapability<Receipt>;
}
export interface ProtectStorageFileWorkflowWorkspaceOptions<
  Receipt,
> extends StorageFileWorkflowProtection {
  /** Host catalog delegate, already restricted to the same trusted scope. */
  readonly workspace: StorageWorkspace;
  readonly workflows: StorageFileWorkflowCapability<Receipt>;
  readonly catalog?: StorageFileCatalogCapability<Receipt>;
}

/** For host-owned feature closures captured during capability acquisition. */
export async function protectStorageFileWorkflowOperation<Result>(
  protection: StorageFileWorkflowProtection & {
    readonly permission: StorageFileWorkflowPermission;
    readonly operationSignal?: AbortSignal | undefined;
  },
  work: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const signal =
    protection.operationSignal === undefined
      ? protection.signal
      : AbortSignal.any([protection.signal, protection.operationSignal]);
  signal.throwIfAborted();
  await protection.authorize({ permission: protection.permission, signal });
  signal.throwIfAborted();
  // A completed mutation must return its receipt even if abort races its response.
  return work(signal);
}

export function protectStorageFileWorkflowWorkspace<Receipt>(
  options: ProtectStorageFileWorkflowWorkspaceOptions<Receipt>,
): StorageFileWorkflowWorkspace<Receipt> {
  const { workspace, catalog } = options;
  const workflows = options.workflows.restrict({
    mutations: [
      ...(workspace.allows('create') ? ['create' as const] : []),
      ...(workspace.allows('replace') ? ['replace' as const] : []),
    ],
    signal: options.signal,
  });
  const run = <T>(
    permission: StorageFileWorkflowPermission,
    input: StorageFileWorkflowOperation,
    work: (signal: AbortSignal) => Promise<T>,
  ) =>
    protectStorageFileWorkflowOperation(
      { ...options, permission, operationSignal: input.signal },
      work,
    );
  const requireBase = (permission: StorageWorkspacePermission) => {
    if (!workspace.allows(permission)) denied();
  };
  const requireMutation = (expectedEtag: string | null | undefined) =>
    requireBase(expectedEtag == null ? 'create' : 'replace');
  const workflowRead = <T>(
    input: StorageFileWorkflowOperation,
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    requireBase('read');
    if (!workflows.allows('read')) denied();
    return run('read', input, work);
  };
  const workflowWrite = <T>(
    permission: 'write' | 'commit',
    input: StorageFileWorkflowOperation,
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (
      (!workspace.allows('create') && !workspace.allows('replace')) ||
      !workflows.allows(permission)
    )
      denied();
    return run(permission, input, work);
  };
  const protectedWorkflows = Object.freeze<
    StorageFileWorkflowCapability<Receipt>
  >({
    kind: 'storage-file-workflow',
    version: 1,
    limits: Object.freeze({ ...workflows.limits }),
    restrict: (restriction) =>
      protectStorageFileWorkflowWorkspace({
        ...options,
        workflows: workflows.restrict(restriction),
      }).workflows,
    allows: (permission) =>
      workflows.allows(permission) &&
      (permission === 'read'
        ? workspace.allows('read')
        : workspace.allows('create') || workspace.allows('replace')),
    begin: (input) => {
      const snapshot = { ...input };
      requireMutation(snapshot.expectedEtag);
      return workflowWrite('write', snapshot, (signal) =>
        workflows.begin({ ...snapshot, signal }),
      );
    },
    list: (input = {}) =>
      workflowRead(input, (signal) => workflows.list({ ...input, signal })),
    read: (input) =>
      workflowRead(input, (signal) => workflows.read({ ...input, signal })),
    parts: (input) =>
      workflowRead(input, (signal) => workflows.parts({ ...input, signal })),
    append: (input) => {
      const snapshot = { ...input, bytes: input.bytes.slice() };
      return workflowWrite('write', snapshot, (signal) =>
        workflows.append({ ...snapshot, signal }),
      );
    },
    cancel: (input) =>
      workflowWrite('write', input, (signal) =>
        workflows.cancel({ ...input, signal }),
      ),
    commit: (input) => {
      const snapshot = {
        ...input,
        drafts: input.drafts.map((draft) => ({ ...draft })),
      };
      return workflowWrite('commit', snapshot, (signal) =>
        workflows.commit({ ...snapshot, signal }),
      );
    },
  });
  const base = protectBase(workspace, options);
  if (catalog === undefined)
    return Object.freeze({ ...base, workflows: protectedWorkflows });
  const limits = Object.freeze({
    ...catalog.limits,
    maxReadBytes: Math.min(
      catalog.limits.maxReadBytes,
      workspace.limits.maxReadBytes,
    ),
    maxWriteBytes: Math.min(
      catalog.limits.maxWriteBytes,
      workspace.limits.maxWriteBytes,
    ),
    maxPageSize: Math.min(
      catalog.limits.maxPageSize,
      workspace.limits.maxPageSize,
    ),
    maxPathBytes: Math.min(
      catalog.limits.maxPathBytes,
      workspace.limits.maxPathBytes,
    ),
  });
  for (const [name, value] of Object.entries(limits))
    storageInteger(value, name, 1);
  const catalogRun = <T>(
    permission: 'read' | 'write',
    input: StorageFileWorkflowOperation,
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (!catalog.allows(permission)) denied();
    if (permission === 'read') requireBase('read');
    return run(permission, input, work);
  };
  const textLimit = (text: string) => {
    if (/[\uD800-\uDFFF]/u.test(text))
      throw new StorageError('Text must be well-formed UTF-8.', {
        code: 'INVALID_ARGUMENT',
      });
    if (new TextEncoder().encode(text).byteLength > limits.maxWriteBytes)
      throw new StorageError('Catalog write exceeds its byte budget.', {
        code: 'LIMIT_EXCEEDED',
      });
  };
  const protectedCatalog = Object.freeze<StorageFileCatalogCapability<Receipt>>(
    {
      kind: 'storage-file-catalog',
      version: 1,
      limits,
      allows: (permission) =>
        catalog.allows(permission) &&
        (permission === 'read'
          ? workspace.allows('read')
          : workspace.allows('create') || workspace.allows('replace')),
      list: (input) => {
        requireBase('list');
        return catalogRun('read', input, async (signal) => {
          const page = await catalog.list({ ...input, signal });
          checkPage(page.items.length, limits.maxPageSize);
          return page;
        });
      },
      stat: (input) =>
        catalogRun('read', input, (signal) =>
          catalog.stat({ ...input, signal }),
        ),
      search: (input) => {
        requireBase('search');
        return catalogRun('read', input, async (signal) => {
          const page = await catalog.search({ ...input, signal });
          checkPage(page.items.length, limits.maxPageSize);
          return page;
        });
      },
      readWindow: (input) =>
        catalogRun('read', input, async (signal) => {
          const page = await catalog.readWindow({ ...input, signal });
          checkPage(
            new TextEncoder().encode(page.content ?? '').byteLength,
            limits.maxReadBytes,
          );
          return page;
        }),
      searchContent: (input) => {
        requireBase('search');
        return catalogRun('read', input, async (signal) => {
          const page = await catalog.searchContent({ ...input, signal });
          checkPage(page.matches.length, limits.maxSearchMatches);
          return page;
        });
      },
      write: (input) => {
        const snapshot = { ...input };
        requireMutation(snapshot.expectedEtag);
        textLimit(snapshot.content);
        return catalogRun('write', snapshot, (signal) =>
          catalog.write({ ...snapshot, signal }),
        );
      },
      edit: (input) => {
        const snapshot = { ...input, change: { ...input.change } };
        requireBase('replace');
        if (snapshot.change.kind === 'append') textLimit(snapshot.change.text);
        else {
          textLimit(snapshot.change.oldText);
          textLimit(snapshot.change.newText);
        }
        return catalogRun('write', snapshot, (signal) =>
          catalog.edit({ ...snapshot, signal }),
        );
      },
    },
  );
  return Object.freeze({
    ...base,
    workflows: protectedWorkflows,
    catalog: protectedCatalog,
  });
}

/** Structural extension lookup survives host-owned feature properties on the handle. */
export function getStorageFileWorkflow<Receipt = unknown>(
  workspace: StorageWorkspace,
): StorageFileWorkflowCapability<Receipt> {
  const capability = (
    workspace as Partial<StorageFileWorkflowWorkspace<Receipt>>
  ).workflows;
  if (
    capability?.kind !== 'storage-file-workflow' ||
    capability.version !== 1 ||
    [
      'allows',
      'restrict',
      'begin',
      'list',
      'read',
      'parts',
      'append',
      'cancel',
      'commit',
    ].some((method) => typeof Reflect.get(capability, method) !== 'function')
  )
    throw new StorageError('Protected file workflow is unavailable.', {
      code: 'NOT_SUPPORTED',
    });
  return capability;
}
export function getStorageFileCatalog<Receipt = unknown>(
  workspace: StorageWorkspace,
): StorageFileCatalogCapability<Receipt> {
  const capability = (
    workspace as Partial<StorageFileWorkflowWorkspace<Receipt>>
  ).catalog;
  if (
    capability?.kind !== 'storage-file-catalog' ||
    capability.version !== 1 ||
    [
      'allows',
      'list',
      'stat',
      'search',
      'readWindow',
      'searchContent',
      'write',
      'edit',
    ].some((method) => typeof Reflect.get(capability, method) !== 'function')
  )
    throw new StorageError('Protected file catalog is unavailable.', {
      code: 'NOT_SUPPORTED',
    });
  return capability;
}

function protectBase(
  workspace: StorageWorkspace,
  protection: StorageFileWorkflowProtection,
): StorageWorkspace {
  const run = <T>(
    permission: StorageWorkspacePermission,
    input: StorageOperationOptions | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ) => {
    if (!workspace.allows(permission)) denied();
    return protectStorageFileWorkflowOperation(
      {
        ...protection,
        permission: ['read', 'list', 'search'].includes(permission)
          ? 'read'
          : 'write',
        operationSignal: input?.signal,
      },
      work,
    );
  };
  return Object.freeze({
    get permissions() {
      return new Set(workspace.permissions);
    },
    limits: Object.freeze({ ...workspace.limits }),
    allows: (permission) => workspace.allows(permission),
    stat: (path, input) =>
      run('read', input, (signal) =>
        workspace.stat(path, { ...input, signal }),
      ),
    readText: (path, input) =>
      run('read', input, (signal) =>
        workspace.readText(path, { ...input, signal }),
      ),
    readBytes: (path, input) =>
      run('read', input, (signal) =>
        workspace.readBytes(path, { ...input, signal }),
      ),
    list: (input) =>
      run('list', input, (signal) => workspace.list({ ...input, signal })),
    search: (query, input) =>
      run('search', input, (signal) =>
        workspace.search(query, { ...input, signal }),
      ),
    writeFile: (path, body, input) => {
      const snapshot = typeof body === 'string' ? body : body.slice();
      const request = { ...input };
      return run(
        request.mode === 'overwrite'
          ? 'write'
          : request.mode === 'create'
            ? 'create'
            : 'replace',
        request,
        (signal) => workspace.writeFile(path, snapshot, { ...request, signal }),
      );
    },
    copyFile: (source, destination, input) =>
      run('copy', input, (signal) =>
        workspace.copyFile(source, destination, { ...input, signal }),
      ),
    moveFile: (source, destination, input) =>
      run('move', input, (signal) =>
        workspace.moveFile(source, destination, { ...input, signal }),
      ),
    deleteFile: (path, input) =>
      run('delete', input, (signal) =>
        workspace.deleteFile(path, { ...input, signal }),
      ),
    // A child mount must never inherit its parent's broader catalog/workflow.
    mount: (directory, input) => {
      protection.signal.throwIfAborted();
      return protectBase(workspace.mount(directory, input), protection);
    },
  } satisfies StorageWorkspace);
}
function checkPage(size: number, maximum: number) {
  if (size > maximum)
    throw new StorageError('Catalog result exceeds its configured limit.', {
      code: 'LIMIT_EXCEEDED',
    });
}
function denied(): never {
  throw new StorageError('File operation is not permitted.', {
    code: 'UNAUTHORIZED',
  });
}
