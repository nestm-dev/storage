import { tool, type JSONValue, type ToolSet } from 'ai';
import { z } from 'zod';

import {
  STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
  isStorageWorkspaceError,
  type StorageWorkspace,
  type StorageWorkspaceEntry,
  type StorageWorkspaceFile,
  type StorageWorkspaceTextFile,
} from '../workspace/index.js';
import {
  StorageErrorCode,
  isStorageError,
  type StorageErrorCode as StorageErrorCodeValue,
} from '../storage.error.js';
import { isCanonicalStorageEtag } from '../storage-etag.js';

export const AI_SDK_WORKSPACE_TOOL_NAMES = [
  'workspace_list',
  'workspace_stat',
  'workspace_read_file',
  'workspace_search',
  'workspace_write_file',
  'workspace_copy_file',
  'workspace_move_file',
  'workspace_delete_file',
] as const;

export type AiSdkWorkspaceToolName =
  (typeof AI_SDK_WORKSPACE_TOOL_NAMES)[number];

export type AiSdkWorkspaceMutationToolName = Extract<
  AiSdkWorkspaceToolName,
  | 'workspace_write_file'
  | 'workspace_copy_file'
  | 'workspace_move_file'
  | 'workspace_delete_file'
>;

/**
 * Approval policy for mutation tools. An omitted entry defaults to requiring
 * approval, matching an omitted policy.
 */
export type AiSdkWorkspaceApprovalConfig =
  boolean | Partial<Record<AiSdkWorkspaceMutationToolName, boolean>>;

export type AiSdkWorkspaceMutationMode = 'conditional' | 'last-write-wins';

export interface AiSdkWorkspaceCreateConflict {
  /** The logical destination inside the mounted workspace. */
  readonly path: string;
}

export type AiSdkWorkspaceCreateConflictMapper<Result extends JSONValue> = (
  conflict: AiSdkWorkspaceCreateConflict,
) => PromiseLike<Result> | Result;

export interface CreateAiSdkWorkspaceToolsOptions<
  CreateConflictResult extends JSONValue = never,
> {
  /** The already-mounted, policy-enforcing workspace exposed to the tools. */
  workspace: StorageWorkspace;
  /**
   * Optional tighter read ceiling. Values above the workspace ceiling are
   * clamped; the model cannot choose or raise this value.
   */
  maxReadBytes?: number;
  /** Mutation tools require approval by default. */
  requireApproval?: AiSdkWorkspaceApprovalConfig;
  /**
   * Selects the mutation contract exposed to the model. Conditional mode is
   * the default; last-write-wins uses the workspace's ordinary Files path.
   */
  mutationMode?: AiSdkWorkspaceMutationMode;
  /**
   * Maps an atomic create collision to an application result. When omitted,
   * the collision remains an AiSdkWorkspaceToolError like every other storage
   * failure. Replace conflicts are never mapped by this hook. This option is
   * valid only when mutationMode is conditional.
   */
  mapCreateConflict?: AiSdkWorkspaceCreateConflictMapper<CreateConflictResult>;
}

export type AiSdkWorkspaceToolErrorCode = StorageErrorCodeValue;

export interface AiSdkWorkspaceToolErrorOptions {
  /** True when the failed operation may already have committed. */
  readonly applied?: boolean;
  /** Canonical ETag of the committed object, when the provider returned one. */
  readonly appliedEtag?: string;
}

const SAFE_ERROR_MESSAGES: Readonly<
  Record<AiSdkWorkspaceToolErrorCode, string>
> = {
  [StorageErrorCode.NOT_FOUND]: 'The requested workspace path was not found.',
  [StorageErrorCode.UNAUTHORIZED]:
    'This operation is not permitted in the workspace.',
  [StorageErrorCode.CONFLICT]:
    'The operation conflicts with current workspace state. Inspect the affected paths before retrying.',
  [StorageErrorCode.READ_ONLY]:
    'This operation is not permitted in the workspace.',
  [StorageErrorCode.INVALID_ARGUMENT]: 'The workspace tool input was rejected.',
  [StorageErrorCode.NOT_SUPPORTED]:
    'This workspace operation is not supported by the configured storage.',
  [StorageErrorCode.ABORTED]: 'The workspace operation was aborted.',
  [StorageErrorCode.TIMEOUT]: 'The workspace operation timed out.',
  [StorageErrorCode.LIMIT_EXCEEDED]:
    'The workspace operation exceeded a configured limit.',
  [StorageErrorCode.PROVIDER]: 'The workspace operation failed.',
};

/**
 * Safe error exposed at the AI tool boundary. It deliberately carries no
 * provider error, storage key, mount prefix, store name, or cause. Applied
 * reconciliation metadata is retained so callers do not blindly retry a
 * mutation that may already have committed.
 */
export class AiSdkWorkspaceToolError extends Error {
  readonly code: AiSdkWorkspaceToolErrorCode;
  declare readonly applied?: true;
  declare readonly appliedEtag?: string;

  constructor(
    code: AiSdkWorkspaceToolErrorCode,
    options: AiSdkWorkspaceToolErrorOptions = {},
  ) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'AiSdkWorkspaceToolError';
    this.code = code;
    if (options.applied === true) {
      this.applied = true;
      if (
        options.appliedEtag !== undefined &&
        isCanonicalStorageEtag(options.appliedEtag)
      ) {
        this.appliedEtag = options.appliedEtag;
      }
    }
  }
}

export interface AiSdkWorkspaceFileResult {
  kind: 'file';
  path: string;
  name: string;
  size: number;
  contentType: string;
  etag?: string;
  lastModified?: string;
}

export interface AiSdkWorkspaceDirectoryResult {
  kind: 'directory';
  path: string;
  name: string;
}

export type AiSdkWorkspaceEntryResult =
  AiSdkWorkspaceFileResult | AiSdkWorkspaceDirectoryResult;

export interface AiSdkWorkspaceTextFileResult extends AiSdkWorkspaceFileResult {
  text: string;
}

export interface AiSdkWorkspacePageResult {
  entries: AiSdkWorkspaceEntryResult[];
  cursor?: string;
}

const mutationToolNames = new Set<AiSdkWorkspaceMutationToolName>([
  'workspace_write_file',
  'workspace_copy_file',
  'workspace_move_file',
  'workspace_delete_file',
]);
const utf8Encoder = new TextEncoder();
const forbiddenUnicodeCharacter = /\p{C}/u;
const workspaceCursor = /^[A-Za-z0-9._-]+$/u;
const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

function isLogicalPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value !== value.normalize('NFC') ||
    value.includes('\\') ||
    forbiddenUnicodeCharacter.test(value)
  ) {
    return false;
  }

  return value
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes(':') &&
        !segment.endsWith('.') &&
        !segment.endsWith(' ') &&
        !windowsDeviceName.test(segment),
    );
}

function logicalPath(label: string, maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine(isLogicalPath, {
      message: `${label} must be a portable, NFC-normalized, relative POSIX workspace path.`,
    })
    .refine((value) => utf8Encoder.encode(value).byteLength <= maxBytes, {
      message: `${label} exceeds the ${maxBytes}-byte workspace path limit.`,
    })
    .describe(
      `${label}. Use an NFC-normalized relative POSIX path inside the mounted workspace. Empty, dot, parent, colon, trailing dot or space, and Windows reserved device segments are forbidden.`,
    );
}

function searchQuery(maxBytes: number) {
  return z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.includes('\\') && !forbiddenUnicodeCharacter.test(value),
      { message: 'Search query contains forbidden characters.' },
    )
    .refine((value) => utf8Encoder.encode(value).byteLength <= maxBytes, {
      message: `Search query exceeds the ${maxBytes}-byte workspace limit.`,
    })
    .describe('Path pattern or text to find inside the mounted workspace.');
}

function boundedEtag() {
  return z
    .string()
    .refine(isCanonicalStorageEtag, {
      message: 'ETag must be a canonical bare value of at most 1,024 bytes.',
    })
    .describe(
      'Exact canonical bare ETag returned by the latest workspace stat or read.',
    );
}

function continuationCursor(description: string, maxBytes: number) {
  return z
    .string()
    .min(1)
    .max(Math.min(STORAGE_WORKSPACE_MAX_CURSOR_BYTES, maxBytes))
    .regex(
      workspaceCursor,
      'Cursor must be the bounded opaque token returned by the workspace.',
    )
    .optional()
    .describe(description);
}

function positiveIntegerAtMost(maximum: number, description: string) {
  return z
    .number()
    .int()
    .positive()
    .max(maximum)
    .optional()
    .describe(description);
}

function operationOptions(signal: AbortSignal | undefined): {
  signal?: AbortSignal;
} {
  return signal === undefined ? {} : { signal };
}

function resolveApproval(
  toolName: AiSdkWorkspaceMutationToolName,
  config: AiSdkWorkspaceApprovalConfig,
): boolean {
  return typeof config === 'boolean' ? config : (config[toolName] ?? true);
}

function resolveReadLimit(
  workspace: StorageWorkspace,
  requested: number | undefined,
): number {
  const workspaceLimit = workspace.limits.maxReadBytes;
  if (!Number.isSafeInteger(workspaceLimit) || workspaceLimit <= 0) {
    throw new RangeError(
      'workspace.limits.maxReadBytes must be a positive safe integer.',
    );
  }
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || requested <= 0)
  ) {
    throw new RangeError('maxReadBytes must be a positive safe integer.');
  }
  return Math.min(requested ?? workspaceLimit, workspaceLimit);
}

function sanitizeToolError(
  error: unknown,
  signal: AbortSignal | undefined,
): AiSdkWorkspaceToolError {
  if (error instanceof AiSdkWorkspaceToolError) {
    return error;
  }
  const reconciliation =
    isStorageWorkspaceError(error) || isStorageError(error)
      ? {
          applied: error.applied,
          ...(error.appliedEtag !== undefined && {
            appliedEtag: error.appliedEtag,
          }),
        }
      : {};
  if (signal?.aborted === true) {
    return new AiSdkWorkspaceToolError(
      StorageErrorCode.ABORTED,
      reconciliation,
    );
  }
  if (isStorageWorkspaceError(error)) {
    return new AiSdkWorkspaceToolError(error.code, reconciliation);
  }
  if (isStorageError(error)) {
    return new AiSdkWorkspaceToolError(error.code, reconciliation);
  }
  return new AiSdkWorkspaceToolError(StorageErrorCode.PROVIDER);
}

async function executeSafely<Result>(
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    throw sanitizeToolError(error, signal);
  }
}

async function executeCreateAware<
  Result,
  CreateConflictResult extends JSONValue,
>(
  signal: AbortSignal | undefined,
  input: { mode: 'create' | 'replace'; path: string },
  operation: () => Promise<Result>,
  mapCreateConflict:
    AiSdkWorkspaceCreateConflictMapper<CreateConflictResult> | undefined,
): Promise<CreateConflictResult | Result> {
  try {
    return await operation();
  } catch (error) {
    const safeError = sanitizeToolError(error, signal);
    if (
      input.mode === 'create' &&
      safeError.code === StorageErrorCode.CONFLICT &&
      safeError.applied !== true &&
      mapCreateConflict !== undefined
    ) {
      try {
        return await mapCreateConflict({ path: input.path });
      } catch {
        throw new AiSdkWorkspaceToolError(StorageErrorCode.PROVIDER);
      }
    }
    throw safeError;
  }
}

function serializeFile(file: StorageWorkspaceFile): AiSdkWorkspaceFileResult {
  if (file.etag !== undefined && !isCanonicalStorageEtag(file.etag)) {
    throw new Error('Workspace returned a malformed ETag.');
  }
  return {
    kind: 'file',
    path: file.path,
    name: file.name,
    size: file.size,
    contentType: file.contentType,
    ...(file.etag === undefined ? {} : { etag: file.etag }),
    ...(file.lastModified === undefined
      ? {}
      : { lastModified: file.lastModified.toISOString() }),
  };
}

function serializeEntry(
  entry: StorageWorkspaceEntry,
): AiSdkWorkspaceEntryResult {
  return entry.kind === 'file'
    ? serializeFile(entry)
    : { kind: 'directory', path: entry.path, name: entry.name };
}

function serializeTextFile(
  file: StorageWorkspaceTextFile,
): AiSdkWorkspaceTextFileResult {
  return { ...serializeFile(file), text: file.text };
}

function serializePage(page: {
  entries: StorageWorkspaceEntry[];
  cursor?: string;
}): AiSdkWorkspacePageResult {
  return {
    entries: page.entries.map(serializeEntry),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  };
}

/**
 * Creates Vercel AI SDK tools backed only by a mounted StorageWorkspace.
 *
 * A tool is omitted unless the workspace grants its required permission.
 * The workspace remains the enforcing boundary if a retained tool reference
 * is invoked after further narrowing.
 */
export function createAiSdkWorkspaceTools<
  CreateConflictResult extends JSONValue = never,
>({
  workspace,
  maxReadBytes: requestedMaxReadBytes,
  mutationMode = 'conditional',
  requireApproval = true,
  mapCreateConflict,
}: CreateAiSdkWorkspaceToolsOptions<CreateConflictResult>): ToolSet {
  if (mutationMode !== 'conditional' && mutationMode !== 'last-write-wins') {
    throw new RangeError(
      'mutationMode must be "conditional" or "last-write-wins".',
    );
  }
  if (mutationMode === 'last-write-wins' && mapCreateConflict !== undefined) {
    throw new RangeError(
      'mapCreateConflict is available only in conditional mutation mode.',
    );
  }
  const maxReadBytes = resolveReadLimit(workspace, requestedMaxReadBytes);
  const tools: ToolSet = {};
  const pathSchema = logicalPath('File path', workspace.limits.maxPathBytes);
  const directorySchema = logicalPath(
    'Directory path',
    workspace.limits.maxPathBytes,
  );
  const etagSchema = boundedEtag();

  if (workspace.allows('list')) {
    tools.workspace_list = tool({
      description:
        'List files and directories inside the mounted workspace. Omit directory to list the workspace root.',
      // Optional pagination and directory inputs are not compatible with
      // OpenAI strict function schemas, which require every property.
      strict: false,
      inputSchema: z
        .object({
          directory: directorySchema.optional(),
          recursive: z
            .boolean()
            .optional()
            .describe('Whether to include descendants recursively.'),
          limit: positiveIntegerAtMost(
            workspace.limits.maxPageSize,
            `Maximum entries to return, up to ${workspace.limits.maxPageSize}.`,
          ),
          cursor: continuationCursor(
            'Opaque cursor returned by a preceding list call. It may be replayed before expiry while its provider continuation remains valid; repeat the same directory, recursive, and limit options when continuing.',
            workspace.limits.maxCursorBytes,
          ),
        })
        .strict(),
      execute: (input, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializePage(
            await workspace.list({
              ...(input.directory === undefined
                ? {}
                : { directory: input.directory }),
              ...(input.recursive === undefined
                ? {}
                : { recursive: input.recursive }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  }

  if (workspace.allows('read')) {
    tools.workspace_stat = tool({
      description:
        mutationMode === 'conditional'
          ? 'Inspect a file inside the mounted workspace without reading its contents. Returns the ETag required for safe replace, move, and delete operations.'
          : 'Inspect a file inside the mounted workspace without reading its contents. Any returned ETag is informational in last-write-wins mode.',
      strict: true,
      inputSchema: z.object({ path: pathSchema }).strict(),
      execute: ({ path }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeFile(
            await workspace.stat(path, operationOptions(abortSignal)),
          ),
        ),
    });

    tools.workspace_read_file = tool({
      description: `Read a UTF-8 text file inside the mounted workspace. The result is bounded to ${maxReadBytes} bytes.`,
      strict: true,
      inputSchema: z.object({ path: pathSchema }).strict(),
      execute: ({ path }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeTextFile(
            await workspace.readText(path, {
              maxBytes: maxReadBytes,
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  }

  if (workspace.allows('search')) {
    tools.workspace_search = tool({
      description:
        'Search logical paths inside the mounted workspace using a bounded glob, substring, or exact match. Omit directory to search from the workspace root.',
      // Search intentionally has optional filters and cursor inputs.
      strict: false,
      inputSchema: z
        .object({
          query: searchQuery(workspace.limits.maxPathBytes),
          directory: directorySchema.optional(),
          match: z
            .enum(['glob', 'substring', 'exact'])
            .optional()
            .describe('Matching strategy; defaults to glob.'),
          caseInsensitive: z.boolean().optional(),
          limit: positiveIntegerAtMost(
            workspace.limits.maxSearchResults,
            `Maximum matches to return, up to ${workspace.limits.maxSearchResults}.`,
          ),
          cursor: continuationCursor(
            'Opaque cursor returned by a preceding search call. It may be replayed before expiry while its provider continuation remains valid; repeat the same query, directory, match, caseInsensitive, and limit options when continuing.',
            workspace.limits.maxCursorBytes,
          ),
        })
        .strict(),
      execute: (
        { query, directory, match, caseInsensitive, limit, cursor },
        { abortSignal },
      ) =>
        executeSafely(abortSignal, async () =>
          serializePage(
            await workspace.search(query, {
              ...(directory === undefined ? {} : { directory }),
              ...(match === undefined ? {} : { match }),
              ...(caseInsensitive === undefined ? {} : { caseInsensitive }),
              ...(limit === undefined ? {} : { limit }),
              ...(cursor === undefined ? {} : { cursor }),
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  }

  const commonWriteShape = {
    path: pathSchema,
    content: z
      .string()
      .refine(
        (value) =>
          utf8Encoder.encode(value).byteLength <=
          workspace.limits.maxWriteBytes,
        {
          message: `Content exceeds the ${workspace.limits.maxWriteBytes}-byte workspace write limit.`,
        },
      )
      .describe(
        `UTF-8 text to write. The workspace enforces its ${workspace.limits.maxWriteBytes}-byte write limit.`,
      ),
  };
  if (mutationMode === 'last-write-wins' && workspace.allows('write')) {
    const inputSchema = z.object(commonWriteShape).strict();
    tools.workspace_write_file = tool({
      description:
        'Write a UTF-8 text file inside the mounted workspace. An existing destination is overwritten; the last successful writer wins.',
      strict: true,
      inputSchema,
      needsApproval: resolveApproval('workspace_write_file', requireApproval),
      execute: ({ path, content }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeFile(
            await workspace.writeFile(path, content, {
              mode: 'overwrite',
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  } else if (mutationMode === 'conditional') {
    const canCreate = workspace.allows('create');
    const canReplace = workspace.allows('replace');
    if (canCreate || canReplace) {
      const createSchema = z
        .object({ ...commonWriteShape, mode: z.literal('create') })
        .strict();
      const replaceSchema = z
        .object({
          ...commonWriteShape,
          mode: z.literal('replace'),
          etag: etagSchema,
        })
        .strict();
      const inputSchema =
        canCreate && canReplace
          ? z.discriminatedUnion('mode', [createSchema, replaceSchema])
          : canCreate
            ? createSchema
            : replaceSchema;

      tools.workspace_write_file = tool<
        z.infer<typeof inputSchema>,
        unknown,
        Record<string, unknown>
      >({
        description:
          canCreate && canReplace
            ? 'Create a new UTF-8 text file or replace an existing file inside the mounted workspace. Create fails if the destination exists; replace requires its current ETag.'
            : canCreate
              ? 'Create a new UTF-8 text file inside the mounted workspace. The operation fails if the destination already exists.'
              : 'Replace an existing UTF-8 text file inside the mounted workspace using its current ETag.',
        // The combined create/replace schema is a discriminated union. OpenAI
        // strict function tools reject its root-level oneOf, while the runtime
        // Zod schema continues to validate every tool call in non-strict mode.
        strict: !(canCreate && canReplace),
        inputSchema,
        needsApproval: resolveApproval('workspace_write_file', requireApproval),
        execute: (input, { abortSignal }) =>
          executeCreateAware(
            abortSignal,
            input,
            async () =>
              serializeFile(
                input.mode === 'create'
                  ? await workspace.writeFile(input.path, input.content, {
                      mode: 'create',
                      ...operationOptions(abortSignal),
                    })
                  : await workspace.writeFile(input.path, input.content, {
                      mode: 'replace',
                      etag: input.etag,
                      ...operationOptions(abortSignal),
                    }),
              ),
            mapCreateConflict,
          ),
      });
    }
  }

  const canCopy = workspace.allows('copy') && workspace.allows('read');
  if (
    mutationMode === 'last-write-wins' &&
    canCopy &&
    workspace.allows('write')
  ) {
    tools.workspace_copy_file = tool({
      description:
        'Copy the latest readable contents of a file inside the mounted workspace. The source remains intact, and an existing destination is overwritten.',
      strict: true,
      inputSchema: z
        .object({
          source: logicalPath(
            'Source file path',
            workspace.limits.maxPathBytes,
          ),
          destination: logicalPath(
            'Destination file path',
            workspace.limits.maxPathBytes,
          ),
        })
        .strict(),
      needsApproval: resolveApproval('workspace_copy_file', requireApproval),
      execute: ({ source, destination }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeFile(
            await workspace.copyFile(source, destination, {
              mode: 'overwrite',
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  } else if (
    mutationMode === 'conditional' &&
    canCopy &&
    workspace.allows('create')
  ) {
    tools.workspace_copy_file = tool({
      description:
        'Copy an exact observed version of a file inside the mounted workspace. The source remains intact, and the operation fails if the source changed or the destination already exists.',
      strict: true,
      inputSchema: z
        .object({
          source: logicalPath(
            'Source file path',
            workspace.limits.maxPathBytes,
          ),
          destination: logicalPath(
            'Destination file path',
            workspace.limits.maxPathBytes,
          ),
          etag: etagSchema.describe(
            'Exact ETag of the source returned by the latest workspace stat or read.',
          ),
        })
        .strict(),
      needsApproval: resolveApproval('workspace_copy_file', requireApproval),
      execute: ({ source, destination, etag }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeFile(
            await workspace.copyFile(source, destination, {
              etag,
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  }

  if (
    mutationMode === 'conditional' &&
    workspace.allows('move') &&
    workspace.allows('read') &&
    workspace.allows('delete') &&
    workspace.allows('create')
  ) {
    tools.workspace_move_file = tool({
      description:
        "Move a file inside the mounted workspace using the source's current ETag. The operation fails if the destination already exists. If source deletion cannot be confirmed, the destination is retained and the tool reports a conflict; inspect both paths before retrying.",
      strict: true,
      inputSchema: z
        .object({
          source: logicalPath(
            'Source file path',
            workspace.limits.maxPathBytes,
          ),
          destination: logicalPath(
            'Destination file path',
            workspace.limits.maxPathBytes,
          ),
          etag: etagSchema.describe(
            'Exact ETag of the source returned by the latest workspace stat or read.',
          ),
        })
        .strict(),
      needsApproval: resolveApproval('workspace_move_file', requireApproval),
      execute: ({ source, destination, etag }, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
          serializeFile(
            await workspace.moveFile(source, destination, {
              etag,
              ...operationOptions(abortSignal),
            }),
          ),
        ),
    });
  }

  if (
    mutationMode === 'last-write-wins' &&
    workspace.allows('delete') &&
    workspace.allows('write')
  ) {
    tools.workspace_delete_file = tool({
      description:
        'Unconditionally delete the current file at a path inside the mounted workspace.',
      strict: true,
      inputSchema: z.object({ path: pathSchema }).strict(),
      needsApproval: resolveApproval('workspace_delete_file', requireApproval),
      execute: ({ path }, { abortSignal }) =>
        executeSafely(abortSignal, async () => {
          await workspace.deleteFile(path, {
            mode: 'unconditional',
            ...operationOptions(abortSignal),
          });
          return { deleted: true as const, path };
        }),
    });
  } else if (mutationMode === 'conditional' && workspace.allows('delete')) {
    tools.workspace_delete_file = tool({
      description:
        'Delete a file inside the mounted workspace using its current ETag.',
      strict: true,
      inputSchema: z
        .object({
          path: pathSchema,
          etag: etagSchema,
        })
        .strict(),
      needsApproval: resolveApproval('workspace_delete_file', requireApproval),
      execute: ({ path, etag }, { abortSignal }) =>
        executeSafely(abortSignal, async () => {
          await workspace.deleteFile(path, {
            etag,
            ...operationOptions(abortSignal),
          });
          return { deleted: true as const, path };
        }),
    });
  }

  return tools;
}

export function isAiSdkWorkspaceMutationToolName(
  value: string,
): value is AiSdkWorkspaceMutationToolName {
  return mutationToolNames.has(value as AiSdkWorkspaceMutationToolName);
}
