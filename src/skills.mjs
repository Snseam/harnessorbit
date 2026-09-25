import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrchestratorError, invariant } from './errors.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultSkillsDir() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills');
}

export function defaultCaoSkillSource() {
  return path.join(sourceRoot, 'skills', 'cao');
}

function skillError(code, message, details = {}) {
  return new OrchestratorError(code, message, details);
}

async function statOptional(file) {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

async function resolvePotentialPath(file) {
  const resolved = path.resolve(file);
  const parts = resolved.split(path.sep);
  const prefix = resolved.startsWith(path.sep) ? path.sep : '';
  const start = prefix ? 1 : 0;
  for (let end = parts.length; end >= start; end--) {
    const candidate = (prefix + parts.slice(start, end).join(path.sep)) || prefix || '.';
    const stats = await statOptional(candidate);
    if (!stats) continue;
    const real = await fs.realpath(candidate);
    return path.join(real, ...parts.slice(end));
  }
  return resolved;
}

async function sourceInfo(sourceDir) {
  const source = path.resolve(sourceDir);
  const sourceStats = await statOptional(source);
  const sourceExists = !!sourceStats?.isDirectory();
  const skillFile = path.join(source, 'SKILL.md');
  const cliPath = path.join(source, 'scripts', 'cao.mjs');
  const skillStats = sourceExists ? await statOptional(skillFile) : null;
  const cliStats = sourceExists ? await statOptional(cliPath) : null;
  const invalid = [];
  if (!sourceExists) invalid.push('source directory is missing');
  if (sourceExists && !skillStats?.isFile()) invalid.push('SKILL.md is missing or is not a file');
  if (sourceExists && !cliStats?.isFile()) invalid.push('scripts/cao.mjs is missing or is not a file');
  return {
    source,
    sourceExists,
    sourceUsable: invalid.length === 0,
    sourceInvalid: invalid,
    skillFile,
    cliPath,
  };
}

async function linkInfo(skillPath, source) {
  let stats;
  try {
    stats = await fs.lstat(skillPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { installed: false, link: false, target: null };
    throw error;
  }

  if (!stats.isSymbolicLink()) {
    return { installed: false, link: false, target: null, conflict: true };
  }

  let target;
  let matches = false;
  const rawTarget = await fs.readlink(skillPath);
  const lexicalTarget = path.resolve(path.dirname(skillPath), rawTarget);
  try {
    target = await fs.realpath(skillPath);
    matches = target === await fs.realpath(source);
  } catch (error) {
    target = rawTarget;
    matches = lexicalTarget === source;
  }
  return { managedLink: matches, link: true, target, conflict: !matches };
}

async function assertInstallTargetOutsideSource(skillPath, source) {
  const sourceReal = await fs.realpath(source);
  const target = await resolvePotentialPath(skillPath);
  if (inside(sourceReal, target)) {
    throw skillError('skill_target_recursive', `Refusing to install HarnessOrbit skill inside its own source directory: ${skillPath}`, {
      skillPath,
      source,
      target,
    });
  }
}

function commandHint() {
  return {
    canonical: '$cao',
    display: 'HarnessOrbit',
    desktop: 'Type /HarnessOrbit, select HarnessOrbit, then send the skill mention. The legacy /CAO command remains available.',
    cli: '$cao or /skills',
    note: 'Bare slash text without selecting a skill mention may depend on the client.',
  };
}

export async function statusCaoSkill({ skillsDir = defaultSkillsDir(), sourceDir = defaultCaoSkillSource() } = {}) {
  const directory = path.resolve(skillsDir);
  const skillPath = path.join(directory, 'cao');
  const info = await sourceInfo(sourceDir);
  const link = await linkInfo(skillPath, info.source);
  const linked = !!link.managedLink;
  const usable = info.sourceUsable;
  return {
    skillPath,
    source: info.source,
    cliPath: info.cliPath,
    sourceExists: info.sourceExists,
    sourceUsable: usable,
    sourceInvalid: info.sourceInvalid,
    installed: linked && usable,
    linked,
    usable,
    link: link.link,
    target: link.target,
    conflict: !!link.conflict,
    hint: commandHint(),
    codexReloaded: false,
  };
}

export async function installCaoSkill({ skillsDir = defaultSkillsDir(), sourceDir = defaultCaoSkillSource() } = {}) {
  const directory = path.resolve(skillsDir);
  const skillPath = path.join(directory, 'cao');
  const info = await sourceInfo(sourceDir);
  invariant(info.sourceExists, 'skill_source_missing', `HarnessOrbit skill source directory does not exist: ${info.source}`, { source: info.source });
  invariant(info.sourceUsable, 'skill_source_invalid', `HarnessOrbit skill source is incomplete: ${info.source}`, { source: info.source, invalid: info.sourceInvalid });

  const current = await linkInfo(skillPath, info.source);
  if (current.managedLink) {
    return { ...(await statusCaoSkill({ skillsDir: directory, sourceDir: info.source })), reused: true };
  }
  if (current.conflict) {
    throw skillError('skill_conflict', `Refusing to overwrite existing skill path: ${skillPath}`, {
      skillPath,
      source: info.source,
      target: current.target,
      link: current.link,
    });
  }
  await assertInstallTargetOutsideSource(skillPath, info.source);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.symlink(info.source, skillPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const afterRace = await linkInfo(skillPath, info.source);
      if (afterRace.managedLink) return { ...(await statusCaoSkill({ skillsDir: directory, sourceDir: info.source })), reused: true };
      throw skillError('skill_conflict', `Refusing to overwrite existing skill path: ${skillPath}`, {
        skillPath,
        source: info.source,
        target: afterRace.target,
        link: afterRace.link,
      });
    }
    throw error;
  }

  return { ...(await statusCaoSkill({ skillsDir: directory, sourceDir: info.source })), reused: false };
}

export async function uninstallCaoSkill({ skillsDir = defaultSkillsDir(), sourceDir = defaultCaoSkillSource() } = {}) {
  const directory = path.resolve(skillsDir);
  const skillPath = path.join(directory, 'cao');
  const info = await sourceInfo(sourceDir);
  const current = await linkInfo(skillPath, info.source);
  if (current.managedLink) {
    await fs.unlink(skillPath);
    return { ...(await statusCaoSkill({ skillsDir: directory, sourceDir: info.source })), removed: true };
  }
  if (current.link || current.conflict) {
    throw skillError('skill_conflict', `Refusing to remove non-HarnessOrbit skill path: ${skillPath}`, {
      skillPath,
      source: info.source,
      target: current.target,
      link: current.link,
    });
  }
  return { ...(await statusCaoSkill({ skillsDir: directory, sourceDir: info.source })), removed: false };
}
