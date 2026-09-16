import { z } from 'zod';
import { StorageClient } from '../storage.client.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import { StorageFileWorkflow } from '../workspace/storage-file-workflow.js';
import { TestFileHost } from '../../test/helpers/file-workflow-host.js';
import {
  createAiSdkCatalogFileEditSchemas,
  createAiSdkFileWorkflowTools,
} from './ai-sdk-file-workflow-tools.js';

function setup(maxChunkBytes: number) {
  const workflow = new StorageFileWorkflow({
    content: new StorageStagedContentStore({
      client: new StorageClient('test', createMemoryStorageDriver()),
      key: (scope: string, id) => `${scope}/${id}`,
    }),
    persistence: new TestFileHost(),
  }).mount('private-scope');
  return createAiSdkFileWorkflowTools({
    workflow,
    maxChunkBytes,
    requireApproval: false,
  });
}

describe('model-visible durable file contracts', () => {
  it.each(['TimeoutError', 'AbortError'])(
    'preserves %s for interrupted workflow tools',
    async (name) => {
      const controller = new AbortController();
      controller.abort(new DOMException('private source detail', name));
      const tool = setup(32768).workspace_begin_file_draft!;
      await expect(
        tool.execute!(
          { path: 'file.txt', text: true },
          {
            toolCallId: 'cancelled',
            messages: [],
            context: undefined,
            abortSignal: controller.signal,
          },
        ),
      ).rejects.toMatchObject({
        code: name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
      });
    },
  );

  it('exports portable object alternatives without accepting malformed edit items', () => {
    for (const schema of [
      setup(32768).workspace_edit_file_draft!.inputSchema,
      createAiSdkCatalogFileEditSchemas(32768).batch,
    ]) {
      if (!(schema instanceof z.ZodObject))
        throw new Error('Expected object schema');
      const json = z.toJSONSchema(schema);
      expect(json.properties?.changes).toMatchObject({
        type: 'array',
        items: {
          anyOf: [
            {
              type: 'object',
              properties: { kind: { const: 'replace' } },
              required: ['kind', 'oldText', 'newText'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { kind: { const: 'append' } },
              required: ['kind', 'text'],
              additionalProperties: false,
            },
          ],
        },
      });
      expect(JSON.stringify(json)).not.toContain('"oneOf"');
      const changes = schema.shape.changes;
      expect(
        changes.safeParse([
          { kind: 'replace', oldText: 'Old', newText: 'New' },
          { kind: 'append', text: 'More' },
        ]).success,
      ).toBe(true);
      for (const invalid of [
        null,
        '{"kind":"replace","oldText":"Old","newText":"New"}',
        { oldText: 'Old', newText: 'New' },
        { kind: 'replace', oldText: 'Old' },
        { kind: 'append', text: 'More', oldText: 'Old' },
        { kind: 'replace', oldText: '', newText: 'New' },
      ]) {
        expect(changes.safeParse([invalid]).success).toBe(false);
      }
    }
  });

  it.each([8192, 32768])(
    'publishes effective %i-byte limits in descriptions and enforces Unicode bytes',
    (limit) => {
      const tools = setup(limit);
      const append = tools.workspace_append_file_draft!;
      const schema = append.inputSchema;
      if (!(schema instanceof z.ZodObject))
        throw new Error('Expected object schema');
      const json = z.toJSONSchema(schema);
      expect(append.description).toContain(`${limit} UTF-8 bytes`);
      expect(JSON.stringify(json.properties?.content)).toContain(
        `${limit} UTF-8 bytes`,
      );
      expect(JSON.stringify(json.properties?.offset)).toContain(
        'latest receipt',
      );
      const input = {
        draftId: 'draft',
        offset: 0,
        content: 'é'.repeat(limit / 2),
      };
      expect(schema.safeParse(input).success).toBe(true);
      expect(
        schema.safeParse({ ...input, content: input.content + 'é' }).success,
      ).toBe(false);
      expect(schema.safeParse({ ...input, content: '\uD800' }).success).toBe(
        false,
      );
    },
  );

  it('exposes the aggregate edit contract and rejects character-valid byte overflow', () => {
    const edit = setup(32768).workspace_edit_file_draft!;
    const schema = edit.inputSchema;
    if (!(schema instanceof z.ZodObject))
      throw new Error('Expected object schema');
    expect(edit.description).toContain('open or sealed');
    expect(edit.description).toContain('returned id and size');
    const json = z.toJSONSchema(schema);
    expect(JSON.stringify(json.properties?.changes)).toContain(
      '32768 aggregate UTF-8 bytes',
    );
    const input = {
      draftId: 'draft',
      expectedSize: 40000,
      changes: [
        {
          kind: 'replace',
          oldText: 'é'.repeat(8192),
          newText: 'é'.repeat(8192),
        },
      ],
    };
    expect(schema.safeParse(input).success).toBe(true);
    expect(
      schema.safeParse({
        ...input,
        changes: [...input.changes, { kind: 'append', text: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...input,
        changes: [{ oldText: 'old', newText: 'new' }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...input, expectedSize: undefined }).success,
    ).toBe(false);
  });
});
