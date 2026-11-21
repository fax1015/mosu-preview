import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const root = process.cwd();
const packageFiles = [
  "popup.html",
  "popup.css",
  "options.html",
  "options.css",
];
const packageDirs = ["assets", "src"];
const IGNORED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const targets = {
  chrome: {
    ext: "zip",
    manifest(manifest) {
      const next = structuredClone(manifest);
      delete next.browser_specific_settings;
      delete next.background.scripts;
      return next;
    },
  },
  firefox: {
    ext: "xpi",
    manifest(manifest) {
      const next = structuredClone(manifest);
      delete next.minimum_chrome_version;
      delete next.background.service_worker;
      return next;
    },
  },
};

function resolveBuildDate(epochEnv = process.env.SOURCE_DATE_EPOCH) {
  if (epochEnv === undefined || epochEnv === "") {
    return new Date();
  }
  const trimmed = String(epochEnv).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid SOURCE_DATE_EPOCH: "${epochEnv}" (expected non-negative integer seconds).`);
  }
  const epochSeconds = Number(trimmed);
  const date = new Date(epochSeconds * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid SOURCE_DATE_EPOCH: "${epochEnv}".`);
  }
  return date;
}

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function shouldIgnoreEntry(entryName) {
  if (entryName.startsWith(".")) {
    return true;
  }
  return IGNORED_FILE_NAMES.has(entryName.toLowerCase());
}

async function collectPackageFiles(rootDir = root) {
  const files = [];

  for (const file of packageFiles) {
    files.push({
      name: normalizeZipPath(file),
      data: await fs.readFile(path.join(rootDir, file)),
    });
  }

  for (const dir of packageDirs) {
    for (const file of await listFiles(path.join(rootDir, dir))) {
      const relative = path.relative(rootDir, file);
      files.push({
        name: normalizeZipPath(relative),
        data: await fs.readFile(file),
      });
    }
  }

  return files.sort((a, b) => compareCodeUnits(a.name, b.name));
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (shouldIgnoreEntry(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const stats = await fs.lstat(fullPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Symlink is not allowed in packaged extension: ${fullPath}`);
    }
    if (stats.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function createZip(files, buildDate = new Date()) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const { time, date } = dosDateTime(buildDate);

    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE;
    const payload = useDeflate ? deflated : data;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function dosDateTime(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("dosDateTime requires a valid Date.");
  }
  const utcYear = value.getUTCFullYear();
  if (utcYear < 1980) {
    return {
      date: (1 << 5) | 1,
      time: 0,
    };
  }
  if (utcYear > 2107) {
    return {
      date: ((2107 - 1980) << 9) | (12 << 5) | 31,
      time: (23 << 11) | (59 << 5) | 29,
    };
  }
  return {
    date: ((utcYear - 1980) << 9) | ((value.getUTCMonth() + 1) << 5) | value.getUTCDate(),
    time:
      (value.getUTCHours() << 11) |
      (value.getUTCMinutes() << 5) |
      Math.floor(value.getUTCSeconds() / 2),
  };
}

function normalizeZipPath(file) {
  return file.split(path.sep).join("/");
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePackage(target, files, zipData, { expectedVersion = null } = {}) {
  const errors = [];
  const filesByName = new Map();

  for (const file of files) {
    if (filesByName.has(file.name)) {
      errors.push(`Duplicate package entry: ${file.name}`);
      continue;
    }

    if (file.name.includes("\\") || path.posix.isAbsolute(file.name) || file.name.startsWith("../")) {
      errors.push(`Invalid package entry path: ${file.name}`);
    }

    filesByName.set(file.name, Buffer.from(file.data));
  }

  validateZipEntries(zipData, filesByName, errors);

  const manifest = readJsonFile(filesByName, "manifest.json", errors);
  if (manifest) {
    validateManifest(target, manifest, filesByName, errors, expectedVersion);
  }

  validateHtmlReferences(filesByName, errors);
  validateCssReferences(filesByName, errors);
  validateJsImports(filesByName, errors);

  if (errors.length > 0) {
    throw new Error(`Package validation failed for ${target}:\n- ${errors.join("\n- ")}`);
  }
}

function validateZipEntries(zipData, filesByName, errors) {
  const entries = readZipCentralDirectory(zipData, errors);
  if (!entries) {
    return;
  }

  if (entries.length !== filesByName.size) {
    errors.push(`ZIP contains ${entries.length} entries, expected ${filesByName.size}.`);
  }

  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const entriesByName = new Map();
  for (const entry of entries) {
    if (entriesByName.has(entry.name)) {
      errors.push(`Duplicate ZIP central directory entry: ${entry.name}`);
      continue;
    }
    entriesByName.set(entry.name, entry);
  }

  for (const [name, data] of filesByName) {
    const entry = entriesByName.get(name);
    if (!entry) {
      errors.push(`ZIP is missing package entry: ${name}`);
      continue;
    }

    const expectedCrc = crc32(data);
    if (entry.uncompressedSize !== data.length) {
      errors.push(`ZIP uncompressed size mismatch for ${name}: expected ${data.length} bytes.`);
    }
    if (entry.method !== ZIP_METHOD_STORE && entry.method !== ZIP_METHOD_DEFLATE) {
      errors.push(`ZIP uses unsupported compression method ${entry.method} for ${name}.`);
    }
    if (entry.method === ZIP_METHOD_STORE && entry.compressedSize !== data.length) {
      errors.push(`ZIP stored size mismatch for ${name}: expected ${data.length} bytes.`);
    }
    if (entry.crc !== expectedCrc) {
      errors.push(`ZIP CRC mismatch for ${name}.`);
    }

    // Verify local file header and actual payload bytes.
    const localOffset = entry.localHeaderOffset;
    if (localOffset + 30 > zipData.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      errors.push(`ZIP local header is invalid for ${name}.`);
      continue;
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const payloadStart = localNameEnd + localExtraLength;
    const payloadEnd = payloadStart + localCompressedSize;

    if (payloadEnd > zipData.length) {
      errors.push(`ZIP local payload is truncated for ${name}.`);
      continue;
    }
    const localName = Buffer.from(zipData.subarray(localNameStart, localNameEnd)).toString("utf8");
    if (localName !== name) {
      errors.push(`ZIP local header filename mismatch: "${localName}" !== "${name}".`);
    }
    if (localFlags !== entry.flags || localMethod !== entry.method || localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize || localUncompressedSize !== entry.uncompressedSize) {
      errors.push(`ZIP local header metadata disagrees with central directory for ${name}.`);
    }

    const rawPayload = zipData.subarray(payloadStart, payloadEnd);
    let actualBytes;
    try {
      actualBytes = localMethod === ZIP_METHOD_DEFLATE ? inflateRawSync(rawPayload) : rawPayload;
    } catch (error) {
      errors.push(`ZIP payload failed to inflate for ${name}: ${error.message}`);
      continue;
    }
    if (actualBytes.length !== data.length || crc32(actualBytes) !== expectedCrc || !Buffer.from(actualBytes).equals(data)) {
      errors.push(`ZIP local payload content mismatch for ${name}.`);
    }
  }

  for (const name of entriesByName.keys()) {
    if (!filesByName.has(name)) {
      errors.push(`ZIP contains unexpected entry: ${name}`);
    }
  }
}

function readZipCentralDirectory(zipData, errors) {
  if (zipData.length < 22) {
    errors.push("ZIP archive is too small.");
    return null;
  }
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const minEndOffset = Math.max(0, zipData.length - 0xffff - 22);
  let endOffset = -1;

  for (let offset = zipData.length - 22; offset >= minEndOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === zipData.length) {
        endOffset = offset;
        break;
      }
    }
  }

  if (endOffset === -1) {
    errors.push("ZIP end of central directory record is missing or malformed.");
    return null;
  }

  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);

  if (centralOffset + centralSize > endOffset) {
    errors.push("ZIP central directory is out of bounds.");
    return null;
  }

  const entries = [];
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || view.getUint32(cursor, true) !== 0x02014b50) {
      errors.push(`ZIP central directory entry ${index + 1} is invalid.`);
      return null;
    }

    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd + extraLength + commentLength > endOffset) {
      errors.push(`ZIP central directory entry ${index + 1} is truncated.`);
      return null;
    }

    entries.push({
      name: Buffer.from(zipData.subarray(nameStart, nameEnd)).toString("utf8"),
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor = nameEnd + extraLength + commentLength;
  }

  if (cursor !== centralOffset + centralSize) {
    errors.push("ZIP central directory size does not match parsed entries.");
  }

  return entries;
}

function readJsonFile(filesByName, name, errors) {
  const data = filesByName.get(name);
  if (!data) {
    errors.push(`Required file is missing: ${name}`);
    return null;
  }

  try {
    return JSON.parse(data.toString("utf8"));
  } catch (error) {
    errors.push(`${name} is not valid JSON: ${error.message}`);
    return null;
  }
}

function validateManifest(target, manifest, filesByName, errors, expectedVersion = null) {
  if (manifest.manifest_version !== 3) {
    errors.push("manifest.json must use manifest_version 3.");
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
    errors.push("manifest.json must include a semver-like x.y.z version.");
  }

  if (expectedVersion && manifest.version !== expectedVersion) {
    errors.push(`manifest.json version (${manifest.version}) does not match package.json (${expectedVersion}).`);
  }

  if (manifest.background?.type !== "module") {
    errors.push("manifest.background.type must be \"module\".");
  }

  if (typeof manifest.content_security_policy?.extension_pages !== "string"
    || manifest.content_security_policy.extension_pages.trim() === "") {
    errors.push("manifest.content_security_policy.extension_pages must be defined.");
  }

  if (target === "chrome") {
    if ("browser_specific_settings" in manifest) {
      errors.push("Chrome package must not include browser_specific_settings.");
    }
    if (manifest.background?.scripts) {
      errors.push("Chrome package must not include background.scripts.");
    }
    addPackageReference(filesByName, errors, "manifest.background.service_worker", manifest.background?.service_worker);
  }

  if (target === "firefox") {
    if ("minimum_chrome_version" in manifest) {
      errors.push("Firefox package must not include minimum_chrome_version.");
    }
    if (manifest.background?.service_worker) {
      errors.push("Firefox package must not include background.service_worker.");
    }
    if (!Array.isArray(manifest.background?.scripts) || manifest.background.scripts.length === 0) {
      errors.push("Firefox package must include background.scripts.");
    }
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko?.id) {
      errors.push("Firefox package must include browser_specific_settings.gecko.id.");
    }
    if (!gecko?.strict_min_version) {
      errors.push("Firefox package must include browser_specific_settings.gecko.strict_min_version.");
    }
    if (!gecko?.data_collection_permissions) {
      errors.push("Firefox package must include browser_specific_settings.gecko.data_collection_permissions.");
    }
    for (const pattern of manifest.host_permissions ?? []) {
      if (/^[a-z*]+:\/\/[^/]+:\d+\//i.test(pattern)) {
        errors.push(`Firefox host_permissions pattern must not contain a port number: ${pattern}`);
      }
    }
  }

  addPackageReference(filesByName, errors, "manifest.action.default_popup", manifest.action?.default_popup);
  addPackageReference(filesByName, errors, "manifest.options_ui.page", manifest.options_ui?.page);

  for (const [size, iconPath] of Object.entries(manifest.icons ?? {})) {
    addPackageReference(filesByName, errors, `manifest.icons.${size}`, iconPath);
  }

  for (const [size, iconPath] of Object.entries(manifest.action?.default_icon ?? {})) {
    addPackageReference(filesByName, errors, `manifest.action.default_icon.${size}`, iconPath);
  }

  for (const [index, scriptPath] of (manifest.background?.scripts ?? []).entries()) {
    addPackageReference(filesByName, errors, `manifest.background.scripts[${index}]`, scriptPath);
  }
}

function validateHtmlReferences(filesByName, errors) {
  for (const [name, data] of filesByName) {
    if (!name.endsWith(".html")) {
      continue;
    }

    const html = data.toString("utf8").replace(/<!--[\s\S]*?-->/g, "");
    const inlineScriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    while ((scriptMatch = inlineScriptPattern.exec(html))) {
      if (!/\bsrc\s*=/i.test(scriptMatch[1]) && scriptMatch[2].trim().length > 0) {
        errors.push(`Inline <script> in ${name} violates MV3 CSP.`);
      }
    }

    const attributePattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    let match;
    while ((match = attributePattern.exec(html))) {
      addLocalReference(filesByName, errors, name, match[1], "HTML reference");
    }
  }
}

function validateCssReferences(filesByName, errors) {
  for (const [name, data] of filesByName) {
    if (!name.endsWith(".css")) {
      continue;
    }

    const css = data.toString("utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let match;
    while ((match = urlPattern.exec(css))) {
      addLocalReference(filesByName, errors, name, match[1] ?? match[2] ?? match[3], "CSS reference");
    }

    const importPattern = /@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)')/gi;
    while ((match = importPattern.exec(css))) {
      addLocalReference(filesByName, errors, name, match[1] ?? match[2], "CSS @import");
    }
  }
}

function stripJsComments(source) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\" && i + 1 < source.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          out += "\n";
        }
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function validateJsImports(filesByName, errors) {
  for (const [name, data] of filesByName) {
    if (!name.endsWith(".js")) {
      continue;
    }

    const source = stripJsComments(data.toString("utf8"));
    const fromImportPattern = /\b(?:import|export)\s+(?:[^;"']*?\bfrom\s*)?["']([^"']+)["']/g;
    const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    let match;

    while ((match = fromImportPattern.exec(source))) {
      addLocalReference(filesByName, errors, name, match[1], "JS import");
    }

    while ((match = dynamicImportPattern.exec(source))) {
      addLocalReference(filesByName, errors, name, match[1], "JS import");
    }
  }
}

function addPackageReference(filesByName, errors, source, reference) {
  if (typeof reference !== "string" || reference.length === 0) {
    errors.push(`${source} must reference a packaged file.`);
    return;
  }

  if (!filesByName.has(normalizeZipPath(reference))) {
    errors.push(`${source} references missing file: ${reference}`);
  }
}

function addLocalReference(filesByName, errors, fromFile, reference, type) {
  const result = normalizeLocalReference(fromFile, reference);
  if (result === null) {
    return;
  }
  if (typeof result === "object" && result.error) {
    errors.push(`${type} in ${fromFile} ${result.error}: ${reference}`);
    return;
  }

  if (!filesByName.has(result)) {
    errors.push(`${type} in ${fromFile} references missing file: ${reference}`);
  }
}

function normalizeLocalReference(fromFile, reference) {
  const trimmed = String(reference ?? "").trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) {
    return null;
  }
  if (/^node:/i.test(trimmed)) {
    return { error: "uses disallowed Node built-in import" };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) {
    return null;
  }

  const withoutFragment = trimmed.split("#", 1)[0];
  const withoutQuery = withoutFragment.split("?", 1)[0];
  if (withoutQuery === "") {
    return null;
  }

  const baseDir = path.posix.dirname(fromFile);
  const joined = withoutQuery.startsWith("/")
    ? withoutQuery.slice(1)
    : path.posix.join(baseDir === "." ? "" : baseDir, withoutQuery);
  const normalized = path.posix.normalize(joined);

  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return { error: "escapes package root" };
  }
  return normalized;
}

async function runCli() {
  const distDir = path.join(root, "dist");
  const buildDate = resolveBuildDate();
  const requestedTarget = process.argv[2] ?? "all";

  if (requestedTarget !== "all" && !targets[requestedTarget]) {
    throw new Error("Usage: npm run package -- [chrome|firefox|all]");
  }

  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const selectedTargets =
    requestedTarget === "all" ? Object.keys(targets) : [requestedTarget];

  await fs.mkdir(distDir, { recursive: true });

  for (const target of selectedTargets) {
    const { ext, manifest: transformManifest } = targets[target];
    const files = await collectPackageFiles(root);
    files.unshift({
      name: "manifest.json",
      data: Buffer.from(`${JSON.stringify(transformManifest(manifest), null, 2)}\n`),
    });

    const outputName = `mosu!-preview-${target} v${manifest.version}.${ext}`;
    const outputPath = path.join(distDir, outputName);
    const zipData = createZip(files, buildDate);
    validatePackage(target, files, zipData, { expectedVersion: pkg.version });
    console.log(`checked dist/${outputName} (${files.length} files, ${zipData.length} bytes)`);
    await fs.writeFile(outputPath, zipData);
    console.log(`created dist/${outputName}`);
  }
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  await runCli();
}

export {
  collectPackageFiles,
  crc32,
  createZip,
  dosDateTime,
  normalizeLocalReference,
  resolveBuildDate,
  stripJsComments,
  targets,
  validateJsImports,
  validatePackage,
};
