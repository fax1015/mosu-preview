import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_RESULTS_PATH = resolve(projectRoot, 'performance-results', 'results.jsonl');
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

export const getEnvironmentInfo = () => ({
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  cpuModel: os.cpus()[0]?.model?.trim() || null,
  cpuCount: os.cpus().length,
});

export const readBuildInfo = async () => {
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

export const formatRelativeResultsPath = (targetPath = DEFAULT_RESULTS_PATH) => (
  relative(projectRoot, targetPath).split(sep).join('/')
);

export const buildPerformanceRecord = async (kind, result) => ({
  ...result,
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  kind,
  build: await readBuildInfo(),
  environment: getEnvironmentInfo(),
});

export const appendPerformanceResult = async (
  kind,
  result,
  { resultsFile = DEFAULT_RESULTS_PATH, record: prebuiltRecord = null } = {},
) => {
  const record = prebuiltRecord || await buildPerformanceRecord(kind, result);

  await mkdir(dirname(resultsFile), { recursive: true });
  // Always LF so results.jsonl obeys .gitattributes across Windows and POSIX.
  await appendFile(resultsFile, `${JSON.stringify(record)}\n`, 'utf8');
  return formatRelativeResultsPath(resultsFile);
};

export const readPerformanceResults = async ({
  kind = null,
  limit = null,
  resultsFile = DEFAULT_RESULTS_PATH,
} = {}) => {
  let raw;
  try {
    raw = await readFile(resultsFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      if (kind && parsed.kind !== kind) continue;
      records.push(parsed);
    } catch {
      // Ignore malformed lines rather than breaking history views.
    }
  }

  if (Number.isInteger(limit) && limit > 0 && records.length > limit) {
    return records.slice(-limit);
  }
  return records;
};

export { DEFAULT_RESULTS_PATH };
