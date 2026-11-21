import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const resultsPath = resolve(projectRoot, 'performance-results', 'results.jsonl');
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_UNTRACKED_FINGERPRINT_BYTES = 16 * 1024 * 1024;

const runGit = async (args, { encoding = 'utf8' } = {}) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: projectRoot,
    encoding,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return stdout;
};

const readBuildInfo = async () => {
  let version = 'unknown';
  try {
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    version = packageJson.version || version;
  } catch {
    // Recorded as 'unknown' rather than failing the run.
  }

  let gitCommit = null;
  let gitBranch = null;
  let workingTreeClean = null;
  let workingTreeFingerprint = null;
  try {
    gitCommit = (await runGit(['rev-parse', 'HEAD'])).trim();
    gitBranch = (await runGit(['branch', '--show-current'])).trim() || null;
    const trackedChanges = await runGit(
      ['diff', 'HEAD', '--binary', '--', '.', ':(exclude)performance-results/results.jsonl'],
      { encoding: 'buffer' },
    );
    const untrackedPaths = (await runGit(['ls-files', '--others', '--exclude-standard']))
      .split(/\r?\n/)
      .filter((filePath) => (
        filePath && filePath.replaceAll('\\', '/') !== 'performance-results/results.jsonl'
      ));
    workingTreeClean = trackedChanges.length === 0 && untrackedPaths.length === 0;
    if (!workingTreeClean) {
      const fingerprint = createHash('sha256').update(trackedChanges);
      for (const filePath of untrackedPaths.sort()) {
        fingerprint.update(filePath);
        try {
          const fullPath = resolve(projectRoot, filePath);
          const info = await lstat(fullPath);
          if (info.isFile() && info.size <= MAX_UNTRACKED_FINGERPRINT_BYTES) {
            fingerprint.update(await readFile(fullPath));
          } else {
            fingerprint.update(`meta:${info.size}:${info.mtimeMs}`);
          }
        } catch {
          fingerprint.update('unreadable');
        }
      }
      workingTreeFingerprint = fingerprint.digest('hex');
    }
  } catch {
    // Not a git checkout, or git is unavailable: the revision fields stay null.
  }

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
  // Always LF so results.jsonl obeys .gitattributes across Windows and POSIX.
  await appendFile(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');
  return relative(projectRoot, resultsPath).split(sep).join('/');
};
