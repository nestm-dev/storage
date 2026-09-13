import { z } from 'zod';
import { StorageClient } from '../storage.client.js';
import { StorageStagedContentStore } from '../core/storage-staged-content.js';
import { createMemoryStorageDriver } from '../testing/index.js';
import { StorageFileWorkflow } from '../workspace/storage-file-workflow.js';
import { TestFileHost } from '../../test/helpers/file-workflow-host.js';
import { createAiSdkFileWorkflowTools } from './ai-sdk-file-workflow-tools.js';

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
