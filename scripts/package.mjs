import { promises as fs } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const root = process.cwd();
const distDir = path.join(root, "dist");
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
  await fs.writeFile(outputPath, createZip(files));
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
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
    } else if (entry.isFile()) {
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
    const { time, date } = dosDateTime(new Date());

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
