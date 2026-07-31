# @nestm/storage

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The project intends to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
after the initial experimental releases.

## [Unreleased]

## [0.1.0-alpha.0] - 2026-07-30

### Added

- NestJS 12 dynamic module with local-by-default root and feature registration.
- Default and named stores through `StorageService.use()` and `@InjectStorage()`.
- NestM-owned streaming, buffered, bulk, search, signing, resumable-upload, and
  error contracts backed by `files-sdk`.
- Cross-store streaming transfer and mirror/sync workflows.
- Optional guard-required Express/Fastify HTTP gateway.
- Node 22/24 CI and Changesets-based alpha publishing through npm OIDC.
