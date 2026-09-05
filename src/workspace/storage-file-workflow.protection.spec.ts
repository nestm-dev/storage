import { StorageClient } from '../storage.client.js';
import { StorageError } from '../storage.error.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';
import { TestFileHost } from '../../test/helpers/file-workflow-host.js';
import { StorageFileWorkflow } from './storage-file-workflow.js';
import { mountStorageWorkspace } from './storage-workspace.js';
import type { StorageFileCatalogCapability } from './storage-file-catalog.types.js';
import type { StorageWorkspacePermission } from './storage-workspace.types.js';
import {
  getStorageFileCatalog,
  getStorageFileWorkflow,
  protectStorageFileWorkflowWorkspace,
} from './storage-file-workflow.protection.js';
import {
  createAiSdkCatalogFileTools,
  createAiSdkCatalogFileEditSchemas,
  createAiSdkFileWorkflowTools,
} from '../ai-sdk/ai-sdk-file-workflow-tools.js';
import type { ToolSet } from 'ai';
import { z } from 'zod';

function setup(
  permissions: StorageWorkspacePermission[] = [
    'read',
    'list',
    'search',
    'create',
    'replace',
  ],
) {
  const client = new StorageClient('protected', createMemoryStorageDriver());
  const content = new StorageStagedContentStore({
    client,
    key: (scope: string, id) => `${scope}/${id}`,
  });
  const workflow = new StorageFileWorkflow({
    content,
    persistence: new TestFileHost(),
  }).mount('scope');
  const file = {
    path: 'file.txt',
    fileId: 'file',
    etag: 'etag',
    size: 1,
    contentType: 'text/plain',
  };
  const write = vi.fn(async () => ({ ...file }));
  const edit = vi.fn(async () => ({ ...file }));
  const catalog: StorageFileCatalogCapability = {
    kind: 'storage-file-catalog',
    version: 1,
    limits: {
      maxReadBytes: 4096,
      maxWriteBytes: 8192,
      maxPageSize: 100,
      maxSearchScanBytes: 262144,
      maxSearchMatches: 12,
      maxPathBytes: 1024,
    },
    allows: () => true,
    list: async () => ({ items: [file], nextOffset: null }),
    stat: async () => file,
    search: async () => ({ items: [file], nextOffset: null }),
    readWindow: async () => ({
      ...file,
      content: 'a',
      offset: 0,
      nextOffset: null,
      totalBytes: 1,
    }),
    searchContent: async () => ({
      path: file.path,
      etag: file.etag,
      matches: [],
      nextOffset: null,
    }),
    write,
    edit,
  };
  const controller = new AbortController();
  let revoked = false;
  const authorize = vi.fn(() => {
    if (revoked) throw new StorageError('Denied', { code: 'UNAUTHORIZED' });
  });
  const workspace = protectStorageFileWorkflowWorkspace({
    workspace: mountStorageWorkspace(client, { prefix: 'scope', permissions }),
    workflows: workflow,
    catalog,
    signal: controller.signal,
    authorize,
  });
  return {
    workspace,
    controller,
    authorize,
    write,
    edit,
    revoke: () => {
      revoked = true;
    },
  };
}

interface ToolView {
  inputSchema: z.ZodType;
  needsApproval?: unknown;
  execute?: (
    input: unknown,
    context: {
      toolCallId: string;
      messages: [];
      context: undefined;
      abortSignal?: AbortSignal;
    },
  ) => unknown;
}
function tool(tools: ToolSet, name: string) {
  return tools[name] as unknown as ToolView;
}
const context = {
  toolCallId: 'opaque-call',
  messages: [] as [],
  context: undefined,
};

describe('protected catalog and AI adapters', () => {
  it('allows typed product metadata extensions while retaining generic UTF-8 limits', () => {
    const schemas = createAiSdkCatalogFileEditSchemas(4);
    const extended = schemas.edit.extend({
      manifest: z.strictObject({ enabled: z.boolean() }).optional(),
    });
    expect(
      extended.safeParse({
        path: 'file',
        expectedEtag: 'etag',
        oldText: 'a',
        newText: '😀',
        manifest: { enabled: true },
      }).success,
    ).toBe(true);
    expect(
      extended.safeParse({
        path: 'file',
        expectedEtag: 'etag',
        oldText: 'a',
        newText: '😀a',
      }).success,
    ).toBe(false);
    expect(
      schemas.append.safeParse({
        path: 'file',
        expectedEtag: 'etag',
        content: '\ud800',
      }).success,
    ).toBe(false);
  });
  it('checks persisted draft intent under narrower grants without requiring read permission', async () => {
    const client = new StorageClient('narrow', createMemoryStorageDriver());
    const content = new StorageStagedContentStore({
      client,
      key: (scope: string, id) => `${scope}/${id}`,
    });
    const persistence = new TestFileHost();
    const workflow = new StorageFileWorkflow({ content, persistence }).mount(
      'scope',
    );
    const original = await workflow.begin({
      path: 'existing.txt',
      text: true,
      idempotencyKey: 'initial',
    });
    const [head] = await workflow.commit({
      drafts: [{ draftId: original.id, size: 0 }],
    });
    const replacement = await workflow.begin({
      path: 'existing.txt',
      text: true,
      idempotencyKey: 'replace',
      expectedEtag: head!.etag,
    });
    // Digest failure leaves an already sealed replacement to resume later.
    await expect(
      workflow.commit({
        drafts: [{ draftId: replacement.id, size: 0, sha256: '0'.repeat(64) }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const project = (permissions: StorageWorkspacePermission[]) =>
      getStorageFileWorkflow(
        protectStorageFileWorkflowWorkspace({
          workspace: mountStorageWorkspace(client, {
            prefix: 'scope',
            permissions,
          }),
          workflows: workflow,
          signal: new AbortController().signal,
          authorize: () => {},
        }),
      );
    const createOnly = project(['create']);
    await expect(
      createOnly.commit({ drafts: [{ draftId: replacement.id, size: 0 }] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(persistence.state.heads['scope/existing.txt']!.etag).toBe(
      head!.etag,
    );
    const fresh = await workflow.begin({
      path: 'new.txt',
      text: true,
      idempotencyKey: 'new',
    });
    const replaceOnly = project(['replace']);
    await expect(
      replaceOnly.append({
        draftId: fresh.id,
        offset: 0,
        bytes: new Uint8Array([97]),
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      replaceOnly.commit({ drafts: [{ draftId: fresh.id, size: 0 }] }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(persistence.state.heads['scope/new.txt']).toBeUndefined();
    await expect(
      replaceOnly.commit({ drafts: [{ draftId: replacement.id, size: 0 }] }),
    ).resolves.toHaveLength(1);
    expect(() =>
      createOnly
        .restrict({ mutations: ['replace'] })
        .commit({ drafts: [{ draftId: replacement.id, size: 0 }] }),
    ).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
  });
  it('keeps create-only grants narrow even when catalog advertises write', async () => {
    const { workspace, write, edit } = setup(['read', 'create']);
    const catalog = getStorageFileCatalog(workspace);
    await catalog.write({
      path: 'file.txt',
      content: 'a',
      commandId: 'create',
    });
    expect(write).toHaveBeenCalledOnce();
    expect(() =>
      catalog.write({
        path: 'file.txt',
        content: 'a',
        commandId: 'replace',
        expectedEtag: 'old',
      }),
    ).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(() =>
      catalog.edit({
        path: 'file.txt',
        change: { kind: 'append', text: 'a' },
        commandId: 'edit',
        expectedEtag: 'old',
      }),
    ).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }));
    expect(edit).not.toHaveBeenCalled();
  });
  it('retains protections across host extensions and denies child workflow widening', () => {
    const { workspace } = setup();
    const feature = Symbol('host feature');
    const extended = Object.freeze({ ...workspace, [feature]: () => 'host' });
    expect(getStorageFileCatalog(extended)).toBe(
      getStorageFileCatalog(workspace),
    );
    expect(getStorageFileWorkflow(extended)).toBe(
      getStorageFileWorkflow(workspace),
    );
    expect(() => getStorageFileWorkflow(workspace.mount('child'))).toThrow(
      expect.objectContaining({ code: 'NOT_SUPPORTED' }),
    );
  });
  it('reauthorizes retained tool handles and closes them on lease or caller abort', async () => {
    const host = setup();
    const catalog = getStorageFileCatalog(host.workspace);
    const tools = createAiSdkCatalogFileTools({
      catalog,
      commandId: (id) => `host/${id}`,
      requireApproval: false,
    });
    const input = { path: 'file.txt', content: 'hello' };
    await tool(tools, 'workspace_write_file').execute!(input, context);
    expect(host.write).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: 'host/opaque-call',
        signal: expect.any(AbortSignal),
      }),
    );
    host.revoke();
    await expect(
      tool(tools, 'workspace_stat').execute!({ path: 'file.txt' }, context),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    host.controller.abort();
    await expect(
      tool(tools, 'workspace_stat').execute!({ path: 'file.txt' }, context),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    const other = setup();
    const caller = new AbortController();
    caller.abort();
    await expect(
      getStorageFileCatalog(other.workspace).stat({
        path: 'file',
        signal: caller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(other.authorize).not.toHaveBeenCalled();
  });
  it('owns bounded generic schemas and executes the durable tool protocol', async () => {
    const { workspace } = setup();
    const workflow = getStorageFileWorkflow(workspace);
    const tools = createAiSdkFileWorkflowTools({
      workflow,
      idempotencyKey: (id) => `host/${id}`,
    });
    expect(tool(tools, 'workspace_begin_file_draft').needsApproval).toBe(true);
    expect(
      tool(tools, 'workspace_append_file_draft').inputSchema.safeParse({
        draftId: 'draft',
        offset: 0,
        content: '😀'.repeat(2049),
      }).success,
    ).toBe(false);
    const draft = (await tool(tools, 'workspace_begin_file_draft').execute!(
      { path: 'file.txt' },
      context,
    )) as { id: string };
    await tool(tools, 'workspace_append_file_draft').execute!(
      { draftId: draft.id, offset: 0, content: '😀' },
      context,
    );
    const request = { drafts: [{ draftId: draft.id, size: 4 }] };
    const result = await tool(tools, 'workspace_commit_files').execute!(
      request,
      context,
    );
    expect(result).toMatchObject({ items: [{ path: 'file.txt', size: 4 }] });
    expect(
      await tool(tools, 'workspace_commit_files').execute!(request, context),
    ).toEqual(result);
  });
});
