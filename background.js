const DOWNLOAD_DELAY_MS = 500;

let activeQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_DOWNLOADS") {
    const { files = [], prefix = "CourseMaterials" } = message.payload || {};
    activeQueue = activeQueue.then(() => processQueue(files, prefix));
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "START_ZIP_DOWNLOAD") {
    const { files = [], zipName = "CourseMaterials.zip" } = message.payload || {};
    activeQueue = activeQueue.then(() => processZipQueue(files, zipName));
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function processQueue(files, prefix) {
  const normalizedFiles = Array.isArray(files) ? files.filter((file) => file?.url) : [];
  const usedPaths = new Set();
  let completed = 0;
  let failed = 0;

  notify({
    status: "started",
    total: normalizedFiles.length
  });

  for (const file of normalizedFiles) {
    try {
      const filename = makeDownloadPath(file, prefix, usedPaths);
      await downloadFile(file.url, filename);
      completed += 1;
      notify({
        status: "item",
        processed: completed + failed,
        completed,
        total: normalizedFiles.length,
        fileName: file.name,
        file
      });
    } catch (error) {
      failed += 1;
      notify({
        status: "failed",
        processed: completed + failed,
        completed,
        total: normalizedFiles.length,
        file: {
          ...file,
          error: error.message
        }
      });
    }

    await delay(DOWNLOAD_DELAY_MS);
  }

  notify({
    status: "done",
    completed,
    failed,
    total: normalizedFiles.length
  });
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }

        if (!downloadId) {
          reject(new Error("Chrome did not create a download."));
          return;
        }

        if (url.startsWith("data:")) {
          resolve(downloadId);
          return;
        }

        const onChanged = (delta) => {
          if (delta.id !== downloadId || !delta.state?.current) {
            return;
          }

          if (delta.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            resolve(downloadId);
          }

          if (delta.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            reject(new Error(delta.error?.current || "Download interrupted."));
          }
        };

        chrome.downloads.onChanged.addListener(onChanged);
      }
    );
  });
}

function makeDownloadPath(file, prefix, usedPaths) {
  const segments = [
    sanitizePathSegment(prefix || "CourseMaterials"),
    sanitizePathSegment(file.course || "PESU Course"),
    sanitizePathSegment(file.unit || "Slides"),
    sanitizePathSegment(file.className || "Materials")
  ].filter(Boolean);

  const fileName = ensureFileName(file.name, file.type);
  let path = [...segments, fileName].join("/");
  let counter = 2;

  while (usedPaths.has(path.toLowerCase())) {
    const extension = fileName.match(/(\.[^.]+)$/)?.[1] || "";
    const base = extension ? fileName.slice(0, -extension.length) : fileName;
    path = [...segments, `${base}-${counter}${extension}`].join("/");
    counter += 1;
  }

  usedPaths.add(path.toLowerCase());
  return path;
}

function ensureFileName(name, type) {
  const cleanName = sanitizePathSegment(name || "download");
  if (/\.[a-z0-9]{2,5}$/i.test(cleanName)) {
    return cleanName;
  }
  const extension = sanitizePathSegment(type || "pdf").replace(/^\.+/, "") || "pdf";
  return `${cleanName}.${extension}`;
}

function sanitizePathSegment(segment) {
  return String(segment || "")
    .replace(/[<>:"\\|?*\u0000-\u001f]/g, "-")
    .replace(/\//g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 120) || "Untitled";
}

function notify(payload) {
  chrome.runtime.sendMessage({
    type: "DOWNLOAD_PROGRESS",
    payload
  }).catch(() => {
    // The popup may be closed while downloads continue.
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processZipQueue(files, zipName) {
  const normalizedFiles = Array.isArray(files) ? files.filter((file) => file?.url) : [];
  const cleanZipName = ensureZipExtension(sanitizePathSegment(zipName || "CourseMaterials.zip"));
  const usedPaths = new Set();
  const zipNaming = createZipNamingState(normalizedFiles);
  const entries = [];

  try {
    if (!normalizedFiles.length) {
      throw new Error("No files available to zip.");
    }

    for (let index = 0; index < normalizedFiles.length; index += 1) {
      const file = normalizedFiles[index];
      notifyZip({
        status: "fetching",
        completed: index,
        total: normalizedFiles.length,
        fileName: file.name
      });

      const response = await fetch(file.url, {
        credentials: "include",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`Could not fetch ${file.name || file.url}: HTTP ${response.status}`);
      }

      const bytes = new Uint8Array(await response.arrayBuffer());
      entries.push({
        path: makeZipEntryPath(file, usedPaths, zipNaming),
        bytes,
        date: new Date()
      });

      notifyZip({
        status: "fetching",
        completed: index + 1,
        total: normalizedFiles.length,
        fileName: file.name
      });
    }

    notifyZip({ status: "packing", total: normalizedFiles.length });
    const zipBytes = buildStoredZip(entries);
    await downloadFile(bytesToDataUrl(zipBytes, "application/zip"), cleanZipName);
    notifyZip({ status: "done", total: normalizedFiles.length, zipName: cleanZipName });
  } catch (error) {
    notifyZip({
      status: "failed",
      total: normalizedFiles.length,
      error: error.message
    });
  }
}

function makeZipEntryPath(file, usedPaths, naming) {
  const topicName = sanitizePathSegment(file.className || file.name || "material");
  const topicKey = topicName.toLowerCase();

  if (!naming.topicNumbers.has(topicKey)) {
    naming.topicNumbers.set(topicKey, naming.topicNumbers.size + 1);
    naming.topicCounts.set(topicKey, 0);
  }

  const topicNumber = naming.topicNumbers.get(topicKey);
  const topicFileIndex = naming.topicCounts.get(topicKey) + 1;
  const topicTotal = naming.topicTotals.get(topicKey) || 1;
  naming.topicCounts.set(topicKey, topicFileIndex);

  const extension = getFileExtension(file);
  const prefix = topicTotal === 1
    ? String(topicNumber)
    : `${topicNumber}_${toAlphabeticSuffix(topicFileIndex)}`;
  const fileName = `${prefix}_${topicName}.${extension}`;
  let path = fileName;
  let counter = 2;

  while (usedPaths.has(path.toLowerCase())) {
    const extension = fileName.match(/(\.[^.]+)$/)?.[1] || "";
    const base = extension ? fileName.slice(0, -extension.length) : fileName;
    path = `${base}-${counter}${extension}`;
    counter += 1;
  }

  usedPaths.add(path.toLowerCase());
  return path;
}

function createZipNamingState(files) {
  const topicTotals = new Map();

  for (const file of files) {
    const topicName = sanitizePathSegment(file.className || file.name || "material");
    const topicKey = topicName.toLowerCase();
    topicTotals.set(topicKey, (topicTotals.get(topicKey) || 0) + 1);
  }

  return {
    topicNumbers: new Map(),
    topicCounts: new Map(),
    topicTotals
  };
}

function getFileExtension(file) {
  const nameExtension = String(file.name || "").match(/\.([a-z0-9]{2,5})$/i)?.[1];
  const typeExtension = String(file.type || "").replace(/^\.+/, "");
  return sanitizePathSegment(nameExtension || typeExtension || "pdf").toLowerCase();
}

function toAlphabeticSuffix(index) {
  let value = Math.max(1, index);
  let suffix = "";

  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }

  return suffix;
}

function ensureZipExtension(name) {
  return /\.zip$/i.test(name) ? name : `${name}.zip`;
}

function notifyZip(payload) {
  chrome.runtime.sendMessage({
    type: "ZIP_PROGRESS",
    payload
  }).catch(() => {
    // The popup may be closed while ZIP creation continues.
  });
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.path);
    const crc = crc32(entry.bytes);
    const { time, date } = toDosDateTime(entry.date);
    const localHeader = concatBytes(
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(entry.bytes.length),
      u32(entry.bytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    );

    localParts.push(localHeader, entry.bytes);

    const centralHeader = concatBytes(
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(time),
      u16(date),
      u32(crc),
      u32(entry.bytes.length),
      u32(entry.bytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    );

    centralParts.push(centralHeader);
    offset += localHeader.length + entry.bytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;
  const end = concatBytes(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralSize),
    u32(centralOffset),
    u16(0)
  );

  return concatBytes(...localParts, ...centralParts, end);
}

function bytesToDataUrl(bytes, mimeType) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function utf8(text) {
  return new TextEncoder().encode(text);
}

function u16(value) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
  return bytes;
}

function u32(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function toDosDateTime(dateValue) {
  const date = dateValue instanceof Date ? dateValue : new Date();
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
