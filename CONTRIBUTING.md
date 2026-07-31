# Contributing

Thank you for helping improve `@nestm/storage`.

## Prerequisites

- Node.js 22.12 or newer
- Corepack
- Git

Enable the package manager declared by the repository:

```sh
corepack enable
```

## Local setup

1. Fork and clone the repository.
2. Create a focused branch from `main`.
3. Install the locked dependencies:

   ```sh
   pnpm install --frozen-lockfile
   ```

4. Make the change and add or update tests.
5. Run:

   ```sh
   pnpm run check
   pnpm run test
   pnpm run verify:pack
   ```

6. Add a Changeset for user-visible changes:

   ```sh
   pnpm changeset
   ```

## Design guidelines

- Keep root public contracts owned by `@nestm/storage`; upstream
  `files-sdk` types belong only in the explicit `files-sdk` bridge.
- Preserve streaming and backpressure. Do not buffer an object unless the
  method name and a tested byte limit make that behavior explicit.
- Keep provider-specific dependencies optional and outside the build output.
- Fail closed when a requested capability cannot be honored.
- Keep the HTTP gateway optional, deny-by-default, and protected by Nest guards.
- Keep `StorageModule` local by default.
- Include `.js` suffixes for local imports compiled as Node ESM.

Tests should cover the memory driver contract, named Nest registration,
duplicate isolation, transfer/sync behavior, and both Express and Fastify for
gateway changes. Keep tests deterministic and close every Nest application.

## One-time npm bootstrap

The first prerelease must be published interactively from a clean checkout of
`main`:

```sh
npm publish --access public --tag alpha
```

Then configure npm Trusted Publishing:

```sh
npm trust github @nestm/storage \
  --file release.yml \
  --repository nestm-dev/storage \
  --environment release \
  --allow-publish
```

Subsequent releases use GitHub OIDC with provenance and keep prereleases on the
`alpha` dist-tag.

## Security issues

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](./SECURITY.md).
