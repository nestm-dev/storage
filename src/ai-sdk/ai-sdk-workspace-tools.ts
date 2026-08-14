import { tool, type ToolSet } from 'ai';
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

export interface CreateAiSdkWorkspaceToolsOptions {
  /** The already-mounted, policy-enforcing workspace exposed to the tools. */
  workspace: StorageWorkspace;
  /**
   * Optional tighter read ceiling. Values above the workspace ceiling are
   * clamped; the model cannot choose or raise this value.
   */
  maxReadBytes?: number;
  /** Mutation tools require approval by default. */
  requireApproval?: AiSdkWorkspaceApprovalConfig;
}

export type AiSdkWorkspaceToolErrorCode = StorageErrorCodeValue;

const SAFE_ERROR_MESSAGES: Readonly<
  Record<AiSdkWorkspaceToolErrorCode, string>
> = {
  [StorageErrorCode.NOT_FOUND]: 'The requested workspace path was not found.',
  [StorageErrorCode.UNAUTHORIZED]:
    'This operation is not permitted in the workspace.',
  [StorageErrorCode.CONFLICT]:
    'The operation conflicts with current workspace state. Refresh metadata and retry with the current ETag or a new destination.',
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
 * provider error, storage key, mount prefix, store name, or cause.
 */
export class AiSdkWorkspaceToolError extends Error {
  readonly code: AiSdkWorkspaceToolErrorCode;

  constructor(code: AiSdkWorkspaceToolErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = 'AiSdkWorkspaceToolError';
    this.code = code;
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
  if (signal?.aborted === true) {
    return new AiSdkWorkspaceToolError(StorageErrorCode.ABORTED);
  }
  if (isStorageWorkspaceError(error)) {
    return new AiSdkWorkspaceToolError(error.code);
  }
  if (isStorageError(error)) {
    return new AiSdkWorkspaceToolError(error.code);
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
export function createAiSdkWorkspaceTools({
  workspace,
  maxReadBytes: requestedMaxReadBytes,
  requireApproval = true,
}: CreateAiSdkWorkspaceToolsOptions): ToolSet {
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
      strict: true,
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
        'Inspect a file inside the mounted workspace without reading its contents. Returns the ETag required for safe replace, move, and delete operations.',
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
      strict: true,
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

  const canCreate = workspace.allows('create');
  const canReplace = workspace.allows('replace');
  if (canCreate || canReplace) {
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

    tools.workspace_write_file = tool({
      description:
        canCreate && canReplace
          ? 'Create a new UTF-8 text file or replace an existing file inside the mounted workspace. Create fails if the destination exists; replace requires its current ETag.'
          : canCreate
            ? 'Create a new UTF-8 text file inside the mounted workspace. The operation fails if the destination already exists.'
            : 'Replace an existing UTF-8 text file inside the mounted workspace using its current ETag.',
      strict: true,
      inputSchema,
      needsApproval: resolveApproval('workspace_write_file', requireApproval),
      execute: (input, { abortSignal }) =>
        executeSafely(abortSignal, async () =>
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
        ),
    });
  }

  const canCopy =
    workspace.allows('copy') &&
    workspace.allows('read') &&
    workspace.allows('create');
  if (canCopy) {
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

  const canMove =
    workspace.allows('move') &&
    workspace.allows('read') &&
    workspace.allows('create') &&
    workspace.allows('delete');
  if (canMove) {
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

  if (workspace.allows('delete')) {
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
