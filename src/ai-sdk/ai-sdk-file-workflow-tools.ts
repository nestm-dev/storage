import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { isStorageError } from '../storage.error.js';
import type {
  StorageFileCatalogCapability,
  StorageFileWorkflowCapability,
} from '../workspace/index.js';
import { AiSdkWorkspaceToolError } from './ai-sdk-workspace-tools.js';

export interface CreateAiSdkFileWorkflowToolsOptions<Receipt> {
  readonly workflow: StorageFileWorkflowCapability<Receipt>;
  readonly requireApproval?: boolean;
  /** Host-generated token, scoped and stable across replay of this tool call. */
  readonly idempotencyKey?: (toolCallId: string) => string;
  readonly maxChunkBytes?: number;
}
export interface CreateAiSdkCatalogFileToolsOptions<Receipt> {
  readonly catalog: StorageFileCatalogCapability<Receipt>;
  readonly requireApproval?: boolean;
  readonly commandId?: (toolCallId: string) => string;
  readonly maxWriteBytes?: number;
}
export const AI_SDK_FILE_WORKFLOW_TOOL_NAMES = [
  'workspace_begin_file_draft',
  'workspace_append_file_draft',
  'workspace_list_file_drafts',
  'workspace_read_file_draft',
  'workspace_list_file_draft_parts',
  'workspace_cancel_file_draft',
  'workspace_commit_files',
] as const;
export const AI_SDK_CATALOG_FILE_TOOL_NAMES = [
  'workspace_list',
  'workspace_stat',
  'workspace_search',
  'workspace_read_file',
  'workspace_search_content',
  'workspace_write_file',
  'workspace_append_file',
  'workspace_edit_file',
] as const;

const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.string().min(1).max(256);
const etag = z.string().min(1).max(1024);
const path = z.string().min(1).max(1024);
const page = { offset: offset.default(0) };
function textSchema(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError('Text tool limit must be a positive safe integer.');
  return z
    .string()
    .max(maxBytes)
    .refine(
      (text) => !/[\uD800-\uDFFF]/u.test(text),
      'Text must be well-formed UTF-8.',
    )
    .refine(
      (text) => new TextEncoder().encode(text).byteLength <= maxBytes,
      `Use at most ${maxBytes} UTF-8 bytes per call.`,
    );
}
async function safe<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (isStorageError(error))
      throw new AiSdkWorkspaceToolError(error.code, {
        applied: error.applied,
        ...(error.appliedEtag === undefined
          ? {}
          : { appliedEtag: error.appliedEtag }),
      });
    if (error instanceof DOMException && error.name === 'AbortError')
      throw new AiSdkWorkspaceToolError('ABORTED');
    throw new AiSdkWorkspaceToolError('PROVIDER');
  }
}

/** Generic durable-file tools. Provider upload controls are a separate capability. */
export function createAiSdkFileWorkflowTools<Receipt>(
  options: CreateAiSdkFileWorkflowToolsOptions<Receipt>,
): ToolSet {
  const { workflow } = options;
  const tools: ToolSet = {};
  const content = textSchema(
    Math.min(options.maxChunkBytes ?? 8192, workflow.limits.maxChunkBytes),
  );
  const approval = options.requireApproval ?? true;
  if (workflow.allows('read'))
    Object.assign(tools, {
      workspace_list_file_drafts: tool({
        description:
          'List durable drafts. Resume open drafts at their current UTF-8 byte size; use nextOffset for pagination.',
        inputSchema: z.strictObject(page),
        execute: (input, context) =>
          safe(() => workflow.list({ ...input, signal: context.abortSignal })),
      }),
      workspace_read_file_draft: tool({
        description: `Read a draft window of at most ${workflow.limits.maxReadBytes} UTF-8 bytes. Continue with nextOffset, which is a byte position at a Unicode boundary.`,
        inputSchema: z.strictObject({ draftId: identity, ...page }),
        execute: (input, context) =>
          safe(() => workflow.read({ ...input, signal: context.abortSignal })),
      }),
      workspace_list_file_draft_parts: tool({
        description:
          'List bounded chunk integrity receipts for resumption. Each receipt contains its byte offset, size, and SHA-256.',
        inputSchema: z.strictObject({ draftId: identity, ...page }),
        execute: (input, context) =>
          safe(() => workflow.parts({ ...input, signal: context.abortSignal })),
      }),
    } satisfies ToolSet);
  if (workflow.allows('write'))
    Object.assign(tools, {
      workspace_begin_file_draft: tool({
        strict: false,
        needsApproval: approval,
        description:
          'Begin a durable text draft without changing a visible file. Omit expectedEtag to create a new path; supply the exact current ETag to replace. Use drafts for substantial content and resume interrupted drafts.',
        inputSchema: z.strictObject({ path, expectedEtag: etag.optional() }),
        execute: (input, context) =>
          safe(() =>
            workflow.begin({
              ...input,
              text: true,
              idempotencyKey:
                options.idempotencyKey?.(context.toolCallId) ??
                context.toolCallId,
              signal: context.abortSignal,
            }),
          ),
      }),
      workspace_append_file_draft: tool({
        needsApproval: approval,
        description:
          'Append a bounded UTF-8 chunk at the draft’s returned byte size. Replaying identical bytes at the same offset is safe; different bytes or a stale offset fail.',
        inputSchema: z.strictObject({
          draftId: identity,
          offset,
          content: content.refine((text) => text.length > 0),
        }),
        execute: (input, context) =>
          safe(() =>
            workflow.append({
              draftId: input.draftId,
              offset: input.offset,
              bytes: new TextEncoder().encode(input.content),
              signal: context.abortSignal,
            }),
          ),
      }),
      workspace_cancel_file_draft: tool({
        needsApproval: approval,
        description:
          'Cancel an unfinished draft without changing a visible file. A committed draft cannot be cancelled.',
        inputSchema: z.strictObject({ draftId: identity }),
        execute: (input, context) =>
          safe(() =>
            workflow.cancel({ ...input, signal: context.abortSignal }),
          ),
      }),
    } satisfies ToolSet);
  if (workflow.allows('commit'))
    tools.workspace_commit_files = tool({
      strict: false,
      needsApproval: approval,
      description: `Atomically commit 1–${workflow.limits.maxCommitFiles} distinct completed drafts. Supply exact byte sizes. Optional SHA-256 must be known, never invented. A stale head rolls the whole batch back; replay returns stored receipts.`,
      inputSchema: z.strictObject({
        drafts: z
          .array(
            z.strictObject({
              draftId: identity,
              size: offset,
              sha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/u)
                .optional(),
            }),
          )
          .min(1)
          .max(workflow.limits.maxCommitFiles),
      }),
      execute: (input, context) =>
        safe(async () => ({
          items: await workflow.commit({
            ...input,
            signal: context.abortSignal,
          }),
        })),
    });
  return Object.freeze(tools);
}

/** Catalog-backed alternative to the existing raw-workspace tool factory. */
export function createAiSdkCatalogFileTools<Receipt>(
  options: CreateAiSdkCatalogFileToolsOptions<Receipt>,
): ToolSet {
  const { catalog } = options;
  const tools: ToolSet = {};
  const content = textSchema(
    Math.min(options.maxWriteBytes ?? 8192, catalog.limits.maxWriteBytes),
  );
  const approval = options.requireApproval ?? true;
  const commandId = options.commandId ?? ((toolCallId: string) => toolCallId);
  if (catalog.allows('read'))
    Object.assign(tools, {
      workspace_list: tool({
        strict: false,
        description:
          'List authorized file catalog entries. Paths are mount-relative. Continue with nextOffset.',
        inputSchema: z.strictObject({
          directory: z.string().optional(),
          ...page,
        }),
        execute: (input, context) =>
          safe(() => catalog.list({ ...input, signal: context.abortSignal })),
      }),
      workspace_stat: tool({
        description:
          'Read a file identity, ETag, size and content type without loading its body.',
        inputSchema: z.strictObject({ path }),
        execute: (input, context) =>
          safe(() => catalog.stat({ ...input, signal: context.abortSignal })),
      }),
      workspace_search: tool({
        description:
          'Search file paths by literal substring. Continue with nextOffset even when a page has no matches.',
        inputSchema: z.strictObject({
          query: z.string().min(1).max(256),
          ...page,
        }),
        execute: (input, context) =>
          safe(() => catalog.search({ ...input, signal: context.abortSignal })),
      }),
      workspace_read_file: tool({
        strict: false,
        description: `Read at most ${catalog.limits.maxReadBytes} UTF-8 bytes. offset/nextOffset are byte positions at Unicode boundaries. Continue with nextOffset and the same expectedEtag.`,
        inputSchema: z.strictObject({
          path,
          expectedEtag: etag.optional(),
          ...page,
        }),
        execute: (input, context) =>
          safe(() =>
            catalog.readWindow({ ...input, signal: context.abortSignal }),
          ),
      }),
      workspace_search_content: tool({
        strict: false,
        description: `Search literal text in one exact file revision. Scan at most ${catalog.limits.maxSearchScanBytes} bytes per call. Continue with nextOffset and the same expectedEtag.`,
        inputSchema: z.strictObject({
          path,
          expectedEtag: etag,
          query: z.string().min(1).max(256),
          ...page,
        }),
        execute: (input, context) =>
          safe(() =>
            catalog.searchContent({ ...input, signal: context.abortSignal }),
          ),
      }),
    } satisfies ToolSet);
  if (catalog.allows('write'))
    Object.assign(tools, {
      workspace_write_file: tool({
        strict: false,
        needsApproval: approval,
        description:
          'Create or conditionally replace a small UTF-8 file. Omit expectedEtag to create; supply the exact current ETag to replace. Use durable drafts for substantial content.',
        inputSchema: z.strictObject({
          path,
          expectedEtag: etag.optional(),
          content,
        }),
        execute: (input, context) =>
          safe<unknown>(() =>
            catalog.write({
              ...input,
              commandId: commandId(context.toolCallId),
              signal: context.abortSignal,
            }),
          ),
      }),
      workspace_append_file: tool({
        needsApproval: approval,
        description:
          'Append a bounded UTF-8 chunk to one exact file revision. Pass the latest ETag; retry identity prevents duplicate appends. Durable drafts support large generation.',
        inputSchema: z.strictObject({ path, expectedEtag: etag, content }),
        execute: (input, context) =>
          safe<unknown>(() =>
            catalog.edit({
              path: input.path,
              expectedEtag: input.expectedEtag,
              change: { kind: 'append', text: input.content },
              commandId: commandId(context.toolCallId),
              signal: context.abortSignal,
            }),
          ),
      }),
      workspace_edit_file: tool({
        needsApproval: approval,
        description:
          'Replace one exact unique text span at the latest expectedEtag. oldText must match exactly once. The result carries the next revision receipt.',
        inputSchema: z.strictObject({
          path,
          expectedEtag: etag,
          oldText: content.refine((text) => text.length > 0),
          newText: content,
        }),
        execute: (input, context) =>
          safe<unknown>(() =>
            catalog.edit({
              path: input.path,
              expectedEtag: input.expectedEtag,
              change: {
                kind: 'replace',
                oldText: input.oldText,
                newText: input.newText,
              },
              commandId: commandId(context.toolCallId),
              signal: context.abortSignal,
            }),
          ),
      }),
    } satisfies ToolSet);
  return Object.freeze(tools);
}
