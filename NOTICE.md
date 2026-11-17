# NOTICE

This repository contains work derived from **CloudCLI UI (claudecodeui)**.

## Upstream project

- **Project**: CloudCLI UI / Claude Code UI
- **Repository**: https://github.com/siteboon/claudecodeui
- **Copyright**: Copyright (C) the CloudCLI UI authors and contributors
- **License**: GNU Affero General Public License v3.0 (AGPL-3.0)
- **Baseline used here**: tag/commit `f86543fa` (release v1.37.9)

## What this repository is

A patch set, source snapshot, and documentation for adding
[pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) as a fifth agent provider
inside CloudCLI UI, alongside Claude Code, Codex, Cursor, and OpenCode.

## Nature of the modification

The files under `patches/` and `source/` contain code from the upstream project as
modified by the author of this repository. Specifically:

- `patches/*.patch` are unified diffs against upstream commit `f86543fa`. Applying them
  reproduces the modified tree. The majority of the added lines belong to the upstream
  project's own provider architecture (`server/modules/providers/**`,
  `src/modules/**`), not to original work by this repository's author.
- `source/pi/` is a verbatim snapshot of files **as modified**, including both the new
  provider implementation and the upstream interfaces it plugs into.

This repository's original contribution is the pi provider adapter itself, the fixes
described in `docs/02-pitfalls.md`, and the accompanying documentation.

## Licensing of this repository

Because the material is a modified version of an AGPL-3.0 work, **this repository as a
whole is licensed under AGPL-3.0**. See [`LICENSE`](LICENSE) for the full text.

If you redistribute this repository or a modified version of it, you must:

1. License the whole work under AGPL-3.0;
2. Keep the license text and this notice;
3. State the changes you made; and
4. If you run a modified version as a network service, offer its Corresponding Source
   to users interacting with it over a network (AGPL-3.0 §13).

## Upstream contribution

An upstream pull request addressing the same integration already exists:
[siteboon/claudecodeui#1324](https://github.com/siteboon/claudecodeui/pull/1324).
This repository started from that PR, rebased it onto v1.37.9, and added the fixes
documented here. If you want this work to land upstream, contributing to that PR is
the more direct route than using this repository.

## Trademarks

"pi", "Claude", "Codex", "Cursor", and "OpenCode" are the property of their respective
owners. This repository is not affiliated with or endorsed by any of them.
