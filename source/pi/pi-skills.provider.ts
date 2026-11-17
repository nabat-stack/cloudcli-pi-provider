import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  getPiAgentDir,
  readObjectRecord,
  readStringArray,
} from '@/shared/utils.js';

const directoryExists = async (dirPath: string): Promise<boolean> => {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Reads the extra skill folders pi's `settings.json` points at.
 *
 * pi's user-level `~/.pi/agent/settings.json` accepts a `skills` array of
 * additional directories. Entries are filtered to folders that still exist so a
 * stale path cannot add an empty source; a missing or malformed settings file
 * simply contributes nothing.
 */
const readPiSettingsSkillDirectories = async (): Promise<string[]> => {
  try {
    const settingsPath = path.join(getPiAgentDir(), 'settings.json');
    await access(settingsPath);
    const settings = readObjectRecord(JSON.parse(await readFile(settingsPath, 'utf8')));
    return (readStringArray(settings?.skills) ?? []).filter(
      (entry) => entry.trim().length > 0,
    );
  } catch {
    return [];
  }
};

/**
 * Skills adapter for pi.
 *
 * pi discovers skills in its own user folder, in every folder configured under
 * `skills` in its settings.json, and in the workspace's `.pi/skills` folder —
 * plus the Agent Skills compatibility folder `.agents/skills`, which is where
 * skill packs installed for the `agentskills.io` layout land. A machine's
 * workspace usually has every skill in that compatibility folder, so omitting
 * it makes the page show only the few under `.pi/skills`.
 *
 * The shared base scans each root for `SKILL.md` and de-duplicates by file path,
 * so a skill reachable from both roots is listed once. The managed global write
 * source stays unset, so the inherited addSkills/removeSkill keep rejecting
 * writes until pi exposes a writable skill home.
 */
export class PiSkillsProvider extends SkillsProvider {
  constructor() {
    super('pi');
  }

  protected async getSkillSources(
    workspacePath: string,
    hasRequestedWorkspace = true,
  ): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const resolvedWorkspace = path.resolve(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(getPiAgentDir(), 'skills'),
      commandPrefix: '/',
    });

    for (const configuredDir of await readPiSettingsSkillDirectories()) {
      if (!(await directoryExists(configuredDir))) {
        continue;
      }

      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir: configuredDir,
        commandPrefix: '/',
      });
    }

    // A global listing has no project to scope to; the caller's fallback
    // workspace is the server's own cwd, whose skills are not the user's.
    if (!hasRequestedWorkspace) {
      return sources;
    }

    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(resolvedWorkspace, '.pi', 'skills'),
      commandPrefix: '/',
    });

    // The Agent Skills compatibility folder pi also reads.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(resolvedWorkspace, '.agents', 'skills'),
      commandPrefix: '/',
    });

    return sources;
  }
}
