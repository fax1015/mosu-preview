import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultsPath = resolve(projectRoot, 'performance-results', 'results.jsonl');

const readBuildInfo = async () => {
  let version = 'unknown';
  try {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    version = packageJson.version || version;
  } catch {}

  let gitCommit = null;
  let gitBranch = null;
  let workingTreeClean = null;
  let workingTreeFingerprint = null;
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    gitBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
    const trackedChanges = execFileSync('git', [
      'diff', 'HEAD', '--binary', '--', '.', ':(exclude)performance-results/results.jsonl',
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const untrackedPaths = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter((path) => (
      path && path.replaceAll('\\', '/') !== 'performance-results/results.jsonl'
    ));
    workingTreeClean = trackedChanges.length === 0 && untrackedPaths.length === 0;
    if (!workingTreeClean) {
      const fingerprint = createHash('sha256').update(trackedChanges);
      for (const path of untrackedPaths.sort()) {
        fingerprint.update(path);
        fingerprint.update(await readFile(resolve(projectRoot, path)));
      }
      workingTreeFingerprint = fingerprint.digest('hex');
    }
  } catch {}

  return { version, gitCommit, gitBranch, workingTreeClean, workingTreeFingerprint };
};

export const appendPerformanceResult = async (kind, result) => {
  const record = {
    ...result,
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    kind,
    build: await readBuildInfo(),
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: os.cpus()[0]?.model || null,
      cpuCount: os.cpus().length,
    },
  };

  await mkdir(dirname(resultsPath), { recursive: true });
  await appendFile(resultsPath, `${JSON.stringify(record)}${os.EOL}`, 'utf8');
  return relative(projectRoot, resultsPath).split(sep).join('/');
};
