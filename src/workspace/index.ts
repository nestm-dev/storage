export {
  StorageWorkspaceError,
  isStorageWorkspaceError,
} from './storage-workspace.error.js';
export {
  Aes256GcmStorageWorkspaceCursorCodec,
  STORAGE_WORKSPACE_CURSOR_VERSION,
  STORAGE_WORKSPACE_MAX_CURSOR_BYTES,
  type Aes256GcmStorageWorkspaceCursorCodecOptions,
  type StorageWorkspaceCursorCodec,
  type StorageWorkspaceCursorConfiguration,
  type StorageWorkspaceCursorEncodeOptions,
} from './storage-workspace.cursor.js';
export {
  createStorageWorkspace,
  mountStorageWorkspace,
} from './storage-workspace.js';
export {
  DEFAULT_STORAGE_WORKSPACE_LIMITS,
  STORAGE_WORKSPACE_PERMISSIONS,
  type MountStorageWorkspaceOptions,
  type StorageWorkspaceBody,
  type StorageWorkspaceByteFile,
  type StorageWorkspaceCopyOptions,
  type StorageWorkspaceDeleteOptions,
  type StorageWorkspace,
  type StorageWorkspaceDirectory,
  type StorageWorkspaceEntry,
  type StorageWorkspaceFile,
  type StorageWorkspaceLimits,
  type StorageWorkspaceListOptions,
  type StorageWorkspaceMountOptions,
  type StorageWorkspaceMutationOptions,
  type StorageWorkspaceOverwriteOptions,
  type StorageWorkspacePage,
  type StorageWorkspacePermission,
  type StorageWorkspaceReadOptions,
  type StorageWorkspaceSearchMatch,
  type StorageWorkspaceSearchOptions,
  type StorageWorkspaceTextFile,
  type StorageWorkspaceUnconditionalDeleteOptions,
  type StorageWorkspaceWriteOptions,
} from './storage-workspace.types.js';
