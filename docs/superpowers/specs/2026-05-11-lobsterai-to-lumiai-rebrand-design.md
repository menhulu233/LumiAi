# Brand Rebrand Design: LumiAi → LumiAi

## Overview

Replace all branding references from "LumiAi" to "LumiAi" across the entire codebase.

## Scope

| Category | Files | Changes |
|----------|-------|---------|
| npm config | package.json | name, productName, executableName, appId, author, email |
| electron-builder | electron-builder.json | appId, productName, desktop entry, entitlements |
| i18n | src/renderer/services/i18n.ts | All UI display text |
| app constants | src/main/appConstants.ts | APP_NAME, APP_ID, DB_FILENAME |
| documentation | README.md, README_zh.md | All brand references |
| source code | src/main/, src/renderer/ | String literals |
| system prompts | sandbox/agent-runner/AGENT_SYSTEM_PROMPT.md | Brand references |
| skills | skills/ | Skill documentation |
| URLs | GitHub links | netease-youdao/LumiAi → netease-youdao/LumiAi |

## Naming Convention

- **Display name**: LumiAi (camelCase, retains AI suffix)
- **Internal IDs**: lumiai (lowercase)
- **Database**: lumiai.sqlite → lumiai.sqlite
- **Repository**: LumiAi → LumiAi

## Visual Assets

Icons and visual assets are **NOT** changed in this phase. The lobster mascot remains until a future visual redesign.

## Approach

Scripted bulk replacement followed by lint verification:

1. Find all files containing "LumiAi" or "lumiai"
2. Replace using case-sensitive matching
3. Run `npm run lint` to verify
4. Manual verification of critical files (package.json, electron-builder.json)

## Verification

- [x] `npm run lint` passes with no errors
- [x] `npm run build` succeeds
- [x] Application launches correctly in dev mode

## Date

2026-05-11