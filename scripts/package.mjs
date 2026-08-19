import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const root = process.cwd();
const distDir = path.join(root, "dist");
// One timestamp for the whole run, honouring SOURCE_DATE_EPOCH, so repeated
// builds of the same tree produce byte-identical archives.
const buildDate = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000)
  : new Date();
const requestedTarget = process.argv[2] ?? "all";
const packageFiles = [
  "popup.html",
  "popup.css",
  "options.html",
  "options.css",
];
const packageDirs = ["assets", "src"];
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

if (requestedTarget !== "all" && !targets[requestedTarget]) {
  throw new Error("Usage: npm run package -- [chrome|firefox|all]");
}

const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const selectedTargets =
  requestedTarget === "all" ? Object.keys(targets) : [requestedTarget];

await fs.mkdir(distDir, { recursive: true });

for (const target of selectedTargets) {
  const { ext, manifest: transformManifest } = targets[target];
  const files = await collectPackageFiles();
  files.unshift({
    name: "manifest.json",
    data: Buffer.from(`${JSON.stringify(transformManifest(manifest), null, 2)}\n`),
  });

  const outputName = `mosu!-preview-${target} v${manifest.version}.${ext}`;
  const outputPath = path.join(distDir, outputName);
  const zipData = createZip(files);
  validatePackage(target, files, zipData);
  console.log(`checked dist/${outputName} (${files.length} files)`);
  await fs.writeFile(outputPath, zipData);
  console.log(`created dist/${outputName}`);
}

async function collectPackageFiles() {
  const files = [];

  for (const file of packageFiles) {
    files.push({
      name: normalizeZipPath(file),
      data: await fs.readFile(path.join(root, file)),
    });
  }

  for (const dir of packageDirs) {
    for (const file of await listFiles(path.join(root, dir))) {
      const relative = path.relative(root, file);
      files.push({
        name: normalizeZipPath(relative),
        data: await fs.readFile(file),
      });
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function listFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const stats = await fs.stat(fullPath);

    if (stats.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const crc = crc32(data);
    const { time, date } = dosDateTime(buildDate);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
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
  const year = Math.max(value.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time:
      (value.getHours() << 11) |
      (value.getMinutes() << 5) |
      Math.floor(value.getSeconds() / 2),
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

function validatePackage(target, files, zipData) {
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
    validateManifest(target, manifest, filesByName, errors);
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
    if (entry.uncompressedSize !== data.length || entry.compressedSize !== data.length) {
      errors.push(`ZIP size mismatch for ${name}: expected ${data.length} bytes.`);
    }
    if (entry.crc !== expectedCrc) {
      errors.push(`ZIP CRC mismatch for ${name}.`);
    }
  }

  for (const name of entriesByName.keys()) {
    if (!filesByName.has(name)) {
      errors.push(`ZIP contains unexpected entry: ${name}`);
    }
  }
}

function readZipCentralDirectory(zipData, errors) {
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);
  const minEndOffset = Math.max(0, zipData.length - 0xffff - 22);
  let endOffset = -1;

  for (let offset = zipData.length - 22; offset >= minEndOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }

  if (endOffset === -1) {
    errors.push("ZIP end of central directory record is missing.");
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

    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd + extraLength + commentLength > endOffset) {
      errors.push(`ZIP central directory entry ${index + 1} is truncated.`);
      return null;
    }

    entries.push({
      name: Buffer.from(zipData.subarray(nameStart, nameEnd)).toString("utf8"),
      crc,
      compressedSize,
      uncompressedSize,
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

function validateManifest(target, manifest, filesByName, errors) {
  if (manifest.manifest_version !== 3) {
    errors.push("manifest.json must use manifest_version 3.");
  }

  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
    errors.push("manifest.json must include a semver-like x.y.z version.");
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

    const html = data.toString("utf8");
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

    const css = data.toString("utf8");
    const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
    let match;
    while ((match = urlPattern.exec(css))) {
      addLocalReference(filesByName, errors, name, match[1] ?? match[2] ?? match[3], "CSS reference");
    }
  }
}

function validateJsImports(filesByName, errors) {
  for (const [name, data] of filesByName) {
    if (!name.endsWith(".js")) {
      continue;
    }

    const source = data.toString("utf8");
    const staticImportPattern = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
    const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    let match;

    while ((match = staticImportPattern.exec(source))) {
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
  const normalized = normalizeLocalReference(fromFile, reference);
  if (!normalized) {
    return;
  }

  if (!filesByName.has(normalized)) {
    errors.push(`${type} in ${fromFile} references missing file: ${reference}`);
  }
}

function normalizeLocalReference(fromFile, reference) {
  const trimmed = reference.trim();
  if (
    trimmed === ""
    || trimmed.startsWith("#")
    || /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    || trimmed.startsWith("//")
  ) {
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

  return normalized === "." || normalized.startsWith("../") ? null : normalized;
}
