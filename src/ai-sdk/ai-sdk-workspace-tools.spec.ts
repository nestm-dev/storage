import type { ToolSet } from 'ai';
import { z } from 'zod';

import { StorageErrorCode } from '../storage.error.js';
import {
  StorageWorkspaceError,
  type StorageWorkspace,
  type StorageWorkspaceEntry,
  type StorageWorkspaceFile,
  type StorageWorkspacePermission,
  type StorageWorkspaceTextFile,
} from '../workspace/index.js';
import {
  AiSdkWorkspaceToolError,
  createAiSdkWorkspaceTools,
} from './ai-sdk-workspace-tools.js';

interface ToolView {
  execute?: (
    input: unknown,
    options: {
      toolCallId: string;
      messages: [];
      context: undefined;
      abortSignal?: AbortSignal;
    },
  ) => unknown;
  inputSchema: z.ZodType;
  needsApproval?: unknown;
  strict?: boolean;
}

interface WorkspaceDouble {
  workspace: StorageWorkspace;
  list: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  copyFile: ReturnType<typeof vi.fn>;
  moveFile: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
}

const FILE: StorageWorkspaceFile = {
  kind: 'file',
  path: 'docs/readme.md',
  name: 'readme.md',
  size: 5,
  contentType: 'text/markdown',
  etag: 'etag-1',
  lastModified: new Date('2026-08-12T12:00:00.000Z'),
};

const TEXT_FILE: StorageWorkspaceTextFile = {
  ...FILE,
  text: 'hello',
};

const MALICIOUS_ETAGS = [
  '',
  '"etag-a", "etag-b"',
  'etag-a", "etag-b',
  '*',
  'W/"etag"',
  'w/"etag"',
  'unsafe\r\nIf-Match: *',
  '"etag',
  'etag"',
  '""etag""',
  'etag,other',
  'etag\\other',
  ' etag',
  'etag ',
  'x'.repeat(1_025),
] as const;

function createWorkspaceDouble(
  permissions: readonly StorageWorkspacePermission[],
  maxPathBytes = 1_024,
): WorkspaceDouble {
  const permissionSet = new Set(permissions);
  const list = vi.fn(async () => ({ entries: [] as StorageWorkspaceEntry[] }));
  const stat = vi.fn(async () => FILE);
  const readText = vi.fn(async () => TEXT_FILE);
  const search = vi.fn(async () => ({
    entries: [] as StorageWorkspaceEntry[],
  }));
  const writeFile = vi.fn(async () => FILE);
  const copyFile = vi.fn(async () => FILE);
  const moveFile = vi.fn(async () => FILE);
  const deleteFile = vi.fn(async () => undefined);

  const workspace = {
    permissions: permissionSet,
    limits: {
      maxCursorBytes: 4_096,
      maxPathBytes,
      maxReadBytes: 100,
      maxWriteBytes: 200,
      maxPageSize: 25,
      maxSearchResults: 20,
      maxSearchScan: 100,
      cursorTtlMs: 60_000,
    },
    allows: (permission: StorageWorkspacePermission) =>
      permissionSet.has(permission),
    list,
    stat,
    readText,
    search,
    writeFile,
    copyFile,
    moveFile,
    deleteFile,
  } as unknown as StorageWorkspace;

  return {
    workspace,
    list,
    stat,
    readText,
    search,
    writeFile,
    copyFile,
    moveFile,
    deleteFile,
  };
}

function viewTool(tools: ToolSet, name: string): ToolView {
  const candidate = tools[name] as unknown as ToolView | undefined;
  if (candidate === undefined) {
    throw new Error(`Missing tool: ${name}`);
  }
  return candidate;
}

async function executeTool(
  tools: ToolSet,
  name: string,
  input: unknown,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const execute = viewTool(tools, name).execute;
  if (execute === undefined) {
    throw new Error(`Tool is not executable: ${name}`);
  }
  return await execute(input, {
    toolCallId: 'test-call',
    messages: [],
    context: undefined,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

describe('createAiSdkWorkspaceTools', () => {
  it('returns only tools permitted by the mounted workspace', () => {
    const readOnly = createWorkspaceDouble(['list', 'read', 'search']);
    const tools = createAiSdkWorkspaceTools({ workspace: readOnly.workspace });

    expect(Object.keys(tools).toSorted()).toEqual([
      'workspace_list',
      'workspace_read_file',
      'workspace_search',
      'workspace_stat',
    ]);
    expect('workspace_write_file' in tools).toBe(false);
    expect('workspace_delete_file' in tools).toBe(false);
  });

  it('maps every mutation permission to its tool', () => {
    const fixture = createWorkspaceDouble([
      'read',
      'create',
      'replace',
      'copy',
      'move',
      'delete',
    ]);
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });

    expect(Object.keys(tools).toSorted()).toEqual([
      'workspace_copy_file',
      'workspace_delete_file',
      'workspace_move_file',
      'workspace_read_file',
      'workspace_stat',
      'workspace_write_file',
    ]);
  });

  it('omits compound mutations until all enforcing permissions are present', () => {
    const missingPrerequisites = createWorkspaceDouble(['copy', 'move']);
    expect(
      Object.keys(
        createAiSdkWorkspaceTools({
          workspace: missingPrerequisites.workspace,
        }),
      ),
    ).toEqual([]);

    const copyOnly = createWorkspaceDouble(['read', 'create', 'copy', 'move']);
    const tools = createAiSdkWorkspaceTools({ workspace: copyOnly.workspace });
    expect('workspace_copy_file' in tools).toBe(true);
    expect('workspace_move_file' in tools).toBe(false);
  });

  it('requires approval for mutations by default and supports granular overrides', () => {
    const fixture = createWorkspaceDouble([
      'read',
      'create',
      'copy',
      'move',
      'delete',
    ]);
    const defaults = createAiSdkWorkspaceTools({
      workspace: fixture.workspace,
    });

    expect(viewTool(defaults, 'workspace_write_file').needsApproval).toBe(true);
    expect(viewTool(defaults, 'workspace_copy_file').needsApproval).toBe(true);
    expect(viewTool(defaults, 'workspace_move_file').needsApproval).toBe(true);
    expect(viewTool(defaults, 'workspace_delete_file').needsApproval).toBe(
      true,
    );

    const configured = createAiSdkWorkspaceTools({
      workspace: fixture.workspace,
      requireApproval: {
        workspace_write_file: false,
        workspace_delete_file: false,
      },
    });
    expect(viewTool(configured, 'workspace_write_file').needsApproval).toBe(
      false,
    );
    expect(viewTool(configured, 'workspace_copy_file').needsApproval).toBe(
      true,
    );
    expect(viewTool(configured, 'workspace_delete_file').needsApproval).toBe(
      false,
    );
  });

  it('uses strict schemas and accepts only relative logical paths', () => {
    const fixture = createWorkspaceDouble(['read', 'search', 'create', 'copy']);
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });
    const statSchema = viewTool(tools, 'workspace_stat').inputSchema;
    const copySchema = viewTool(tools, 'workspace_copy_file').inputSchema;
    const searchSchema = viewTool(tools, 'workspace_search').inputSchema;

    for (const path of [
      'src/index.ts',
      'docs/caf\u00e9.md',
      'docs/COM10.txt',
      'docs/console.txt',
    ]) {
      expect(statSchema.safeParse({ path }).success, path).toBe(true);
    }
    for (const path of [
      '/etc/passwd',
      '../secret',
      'a/../secret',
      'C:\\secret',
      'C:/secret',
      'docs/name:stream.txt',
      'docs/report.',
      'docs/report ',
      'CON',
      'docs/aux.txt',
      'docs/COM1.log',
      'docs/lPt9',
      'docs/cafe\u0301.md',
      'docs/zero\u200bwidth.txt',
      'docs/private-\ue000.txt',
    ]) {
      expect(statSchema.safeParse({ path }).success, path).toBe(false);
    }
    expect(
      statSchema.safeParse({ path: 'src/index.ts', providerKey: 'raw/key' })
        .success,
    ).toBe(false);
    expect(
      copySchema.safeParse({
        source: 'from.txt',
        destination: 'to.txt',
        etag: 'source-etag',
      }).success,
    ).toBe(true);
    expect(
      copySchema.safeParse({
        source: 'from.txt',
        destination: 'to.txt',
      }).success,
    ).toBe(false);
    expect(
      copySchema.safeParse({
        source: 'from.txt',
        destination: 'to.txt',
        etag: 'source-etag',
        overwrite: true,
      }).success,
    ).toBe(false);
    expect(
      searchSchema.safeParse({ query: '.*', match: 'regex' }).success,
    ).toBe(false);
    expect(searchSchema.safeParse({ query: 'name:stream' }).success).toBe(true);
    expect(searchSchema.safeParse({ query: 'dir\\*.txt' }).success).toBe(false);
    expect(searchSchema.safeParse({ query: 'zero\u200bwidth' }).success).toBe(
      false,
    );
    expect(searchSchema.safeParse({ query: 'x'.repeat(1_025) }).success).toBe(
      false,
    );
    expect(viewTool(tools, 'workspace_stat').strict).toBe(true);
  });

  it('describes cursor continuation with the bound query options', () => {
    const fixture = createWorkspaceDouble(['list', 'search']);
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });
    const listSchema = z.toJSONSchema(
      viewTool(tools, 'workspace_list').inputSchema,
    );
    const searchSchema = z.toJSONSchema(
      viewTool(tools, 'workspace_search').inputSchema,
    );
    const cursor = `swc1.test.${'a'.repeat(32)}`;

    expect(
      viewTool(tools, 'workspace_list').inputSchema.safeParse({ cursor })
        .success,
    ).toBe(true);
    expect(
      viewTool(tools, 'workspace_list').inputSchema.safeParse({
        cursor: '',
      }).success,
    ).toBe(false);
    expect(
      viewTool(tools, 'workspace_list').inputSchema.safeParse({
        cursor: 'a'.repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      viewTool(tools, 'workspace_search').inputSchema.safeParse({
        query: '*.ts',
        cursor: `${'a'.repeat(31)}+`,
      }).success,
    ).toBe(false);

    expect(listSchema).toMatchObject({
      properties: {
        cursor: {
          description:
            'Opaque cursor returned by a preceding list call. It may be replayed before expiry while its provider continuation remains valid; repeat the same directory, recursive, and limit options when continuing.',
        },
      },
    });
    expect(searchSchema).toMatchObject({
      properties: {
        cursor: {
          description:
            'Opaque cursor returned by a preceding search call. It may be replayed before expiry while its provider continuation remains valid; repeat the same query, directory, match, caseInsensitive, and limit options when continuing.',
        },
      },
    });
  });

  it('narrows the write schema to the granted create or replace mode', () => {
    const createFixture = createWorkspaceDouble(['create']);
    const createTools = createAiSdkWorkspaceTools({
      workspace: createFixture.workspace,
    });
    const createSchema = viewTool(
      createTools,
      'workspace_write_file',
    ).inputSchema;
    expect(
      createSchema.safeParse({
        path: 'new.txt',
        content: 'new',
        mode: 'create',
      }).success,
    ).toBe(true);
    expect(
      createSchema.safeParse({
        path: 'too-large.txt',
        content: 'x'.repeat(201),
        mode: 'create',
      }).success,
    ).toBe(false);
    expect(
      createSchema.safeParse({
        path: 'old.txt',
        content: 'new',
        mode: 'replace',
        etag: 'old-etag',
      }).success,
    ).toBe(false);

    const replaceFixture = createWorkspaceDouble(['replace']);
    const replaceTools = createAiSdkWorkspaceTools({
      workspace: replaceFixture.workspace,
    });
    const replaceSchema = viewTool(
      replaceTools,
      'workspace_write_file',
    ).inputSchema;
    expect(
      replaceSchema.safeParse({
        path: 'old.txt',
        content: 'new',
        mode: 'replace',
      }).success,
    ).toBe(false);
    expect(
      replaceSchema.safeParse({
        path: 'old.txt',
        content: 'new',
        mode: 'replace',
        etag: 'old-etag',
      }).success,
    ).toBe(true);
    expect(
      replaceSchema.safeParse({
        path: 'old.txt',
        content: 'new',
        mode: 'replace',
        etag: 'unsafe\nvalue',
      }).success,
    ).toBe(false);
    expect(
      replaceSchema.safeParse({
        path: 'old.txt',
        content: 'new',
        mode: 'replace',
        etag: 'x'.repeat(1_025),
      }).success,
    ).toBe(false);
  });

  it('rejects non-canonical ETags across every mutation schema', () => {
    const fixture = createWorkspaceDouble([
      'read',
      'create',
      'replace',
      'copy',
      'move',
      'delete',
    ]);
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });
    const schemas = [
      {
        input: (etag: string) => ({
          content: 'replacement',
          etag,
          mode: 'replace',
          path: 'target.txt',
        }),
        schema: viewTool(tools, 'workspace_write_file').inputSchema,
      },
      {
        input: (etag: string) => ({
          destination: 'copy.txt',
          etag,
          source: 'source.txt',
        }),
        schema: viewTool(tools, 'workspace_copy_file').inputSchema,
      },
      {
        input: (etag: string) => ({
          destination: 'move.txt',
          etag,
          source: 'source.txt',
        }),
        schema: viewTool(tools, 'workspace_move_file').inputSchema,
      },
      {
        input: (etag: string) => ({ etag, path: 'target.txt' }),
        schema: viewTool(tools, 'workspace_delete_file').inputSchema,
      },
    ];

    for (const etag of MALICIOUS_ETAGS) {
      for (const { input, schema } of schemas) {
        expect(
          schema.safeParse(input(etag)).success,
          JSON.stringify(etag.slice(0, 80)),
        ).toBe(false);
      }
    }
  });

  it('uses the fixed ETag limit independently of the workspace path limit', () => {
    const fixture = createWorkspaceDouble(
      ['read', 'create', 'replace', 'copy', 'move', 'delete'],
      16,
    );
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });
    const etag = 'a'.repeat(1_024);

    expect(
      viewTool(tools, 'workspace_write_file').inputSchema.safeParse({
        content: 'replacement',
        etag,
        mode: 'replace',
        path: 'target.txt',
      }).success,
    ).toBe(true);
    expect(
      viewTool(tools, 'workspace_copy_file').inputSchema.safeParse({
        destination: 'copy.txt',
        etag,
        source: 'source.txt',
      }).success,
    ).toBe(true);
    expect(
      viewTool(tools, 'workspace_move_file').inputSchema.safeParse({
        destination: 'move.txt',
        etag,
        source: 'source.txt',
      }).success,
    ).toBe(true);
    expect(
      viewTool(tools, 'workspace_delete_file').inputSchema.safeParse({
        etag,
        path: 'target.txt',
      }).success,
    ).toBe(true);
  });

  it('clamps bounded text reads and serializes file metadata', async () => {
    const fixture = createWorkspaceDouble(['read']);
    const controller = new AbortController();
    const tools = createAiSdkWorkspaceTools({
      workspace: fixture.workspace,
      maxReadBytes: 1_000,
    });

    await expect(
      executeTool(
        tools,
        'workspace_read_file',
        { path: 'docs/readme.md' },
        controller.signal,
      ),
    ).resolves.toEqual({
      kind: 'file',
      path: 'docs/readme.md',
      name: 'readme.md',
      size: 5,
      contentType: 'text/markdown',
      etag: 'etag-1',
      lastModified: '2026-08-12T12:00:00.000Z',
      text: 'hello',
    });
    expect(fixture.readText).toHaveBeenCalledWith('docs/readme.md', {
      maxBytes: 100,
      signal: controller.signal,
    });
  });

  it('sanitizes a non-canonical ETag returned by a workspace', async () => {
    const fixture = createWorkspaceDouble(['read']);
    fixture.stat.mockResolvedValueOnce({
      ...FILE,
      etag: '"etag-a", "etag-b"',
    });
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });

    await expect(
      executeTool(tools, 'workspace_stat', { path: 'docs/readme.md' }),
    ).rejects.toMatchObject({
      code: StorageErrorCode.PROVIDER,
      message: 'The workspace operation failed.',
    });
  });

  it('forwards bounded list and search calls and serializes entries', async () => {
    const fixture = createWorkspaceDouble(['list', 'search']);
    fixture.list.mockResolvedValueOnce({
      entries: [{ kind: 'directory', path: 'docs', name: 'docs' }, FILE],
      cursor: 'next-list',
    });
    fixture.search.mockResolvedValueOnce({
      entries: [FILE],
      cursor: 'next-search',
    });
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });

    await expect(
      executeTool(tools, 'workspace_list', {
        directory: 'docs',
        recursive: true,
        limit: 10,
        cursor: 'previous',
      }),
    ).resolves.toMatchObject({
      entries: [
        { kind: 'directory', path: 'docs', name: 'docs' },
        { kind: 'file', path: 'docs/readme.md' },
      ],
      cursor: 'next-list',
    });
    expect(fixture.list).toHaveBeenCalledWith({
      directory: 'docs',
      recursive: true,
      limit: 10,
      cursor: 'previous',
    });

    await expect(
      executeTool(tools, 'workspace_search', {
        query: '*.md',
        directory: 'docs',
        match: 'glob',
        caseInsensitive: true,
        limit: 5,
      }),
    ).resolves.toMatchObject({ cursor: 'next-search' });
    expect(fixture.search).toHaveBeenCalledWith('*.md', {
      directory: 'docs',
      match: 'glob',
      caseInsensitive: true,
      limit: 5,
    });
  });

  it('preserves create-only destinations and required ETag preconditions', async () => {
    const fixture = createWorkspaceDouble([
      'read',
      'create',
      'replace',
      'copy',
      'move',
      'delete',
    ]);
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });

    await executeTool(tools, 'workspace_write_file', {
      path: 'created.txt',
      content: 'created',
      mode: 'create',
    });
    expect(fixture.writeFile).toHaveBeenCalledWith('created.txt', 'created', {
      mode: 'create',
    });

    await executeTool(tools, 'workspace_write_file', {
      path: 'updated.txt',
      content: 'updated',
      mode: 'replace',
      etag: 'replace-etag',
    });
    expect(fixture.writeFile).toHaveBeenCalledWith('updated.txt', 'updated', {
      mode: 'replace',
      etag: 'replace-etag',
    });

    await executeTool(tools, 'workspace_copy_file', {
      source: 'from.txt',
      destination: 'copied.txt',
      etag: 'source-etag',
    });
    expect(fixture.copyFile).toHaveBeenCalledWith('from.txt', 'copied.txt', {
      etag: 'source-etag',
    });

    await executeTool(tools, 'workspace_move_file', {
      source: 'from.txt',
      destination: 'moved.txt',
      etag: 'source-etag',
    });
    expect(fixture.moveFile).toHaveBeenCalledWith('from.txt', 'moved.txt', {
      etag: 'source-etag',
    });

    await expect(
      executeTool(tools, 'workspace_delete_file', {
        path: 'old.txt',
        etag: 'delete-etag',
      }),
    ).resolves.toEqual({ deleted: true, path: 'old.txt' });
    expect(fixture.deleteFile).toHaveBeenCalledWith('old.txt', {
      etag: 'delete-etag',
    });
  });

  it('sanitizes workspace and unknown failures without retaining their cause', async () => {
    const fixture = createWorkspaceDouble(['read']);
    fixture.stat.mockRejectedValueOnce(
      new StorageWorkspaceError(
        'provider bucket secret-bucket/raw/prefix/private.txt was missing',
        {
          code: StorageErrorCode.NOT_FOUND,
          operation: 'stat',
          path: 'private.txt',
          permanent: true,
        },
      ),
    );
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });

    const notFound = await executeTool(tools, 'workspace_stat', {
      path: 'private.txt',
    }).catch((error: unknown) => error);
    expect(notFound).toBeInstanceOf(AiSdkWorkspaceToolError);
    expect(notFound).toMatchObject({
      code: StorageErrorCode.NOT_FOUND,
      message: 'The requested workspace path was not found.',
    });
    expect((notFound as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(notFound)).not.toContain('secret');

    fixture.stat.mockRejectedValueOnce(
      new Error('SDK request leaked https://provider.invalid/private-key'),
    );
    const provider = await executeTool(tools, 'workspace_stat', {
      path: 'private.txt',
    }).catch((error: unknown) => error);
    expect(provider).toMatchObject({
      code: StorageErrorCode.PROVIDER,
      message: 'The workspace operation failed.',
    });
    expect(String(provider)).not.toContain('provider.invalid');
  });

  it('reports an aborted call without exposing the underlying failure', async () => {
    const fixture = createWorkspaceDouble(['read']);
    fixture.stat.mockRejectedValueOnce(new Error('private provider failure'));
    const tools = createAiSdkWorkspaceTools({ workspace: fixture.workspace });
    const controller = new AbortController();
    controller.abort();

    const result = await executeTool(
      tools,
      'workspace_stat',
      { path: 'file.txt' },
      controller.signal,
    ).catch((error: unknown) => error);
    expect(result).toMatchObject({
      code: StorageErrorCode.ABORTED,
      message: 'The workspace operation was aborted.',
    });
  });

  it('rejects invalid factory read limits before creating tools', () => {
    const fixture = createWorkspaceDouble(['read']);

    expect(() =>
      createAiSdkWorkspaceTools({
        workspace: fixture.workspace,
        maxReadBytes: 0,
      }),
    ).toThrow('maxReadBytes must be a positive safe integer.');
  });
});
