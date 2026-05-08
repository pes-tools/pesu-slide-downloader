const DEFAULT_PREFIX = "CourseMaterials";
const DEFAULT_THEME = "light";

const state = {
  files: [],
  failedFiles: [],
  completed: 0,
  total: 0,
  active: false
};

const els = {
  scanPage: document.getElementById("scanPage"),
  themeToggle: document.getElementById("themeToggle"),
  folderPrefix: document.getElementById("folderPrefix"),
  status: document.getElementById("status"),
  progress: document.getElementById("progress"),
  fileList: document.getElementById("fileList"),
  downloadSelected: document.getElementById("downloadSelected"),
  downloadAll: document.getElementById("downloadAll"),
  retryFailed: document.getElementById("retryFailed")
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  chrome.storage.local.get({ folderPrefix: DEFAULT_PREFIX, theme: DEFAULT_THEME }, ({ folderPrefix, theme }) => {
    els.folderPrefix.value = folderPrefix || DEFAULT_PREFIX;
    applyTheme(theme || DEFAULT_THEME);
  });

  els.scanPage.addEventListener("click", scanActivePage);
  els.themeToggle.addEventListener("click", toggleTheme);
  els.downloadSelected.addEventListener("click", downloadSelected);
  els.downloadAll.addEventListener("click", () => downloadAllAsZip());
  els.retryFailed.addEventListener("click", () => startDownloads(state.failedFiles));
  els.folderPrefix.addEventListener("input", () => {
    chrome.storage.local.set({ folderPrefix: getFolderPrefix() });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "DOWNLOAD_PROGRESS") {
      updateProgress(message.payload);
    }

    if (message?.type === "ZIP_PROGRESS") {
      updateZipProgress(message.payload);
    }
  });
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  chrome.storage.local.set({ theme: next });
}

function applyTheme(theme) {
  const normalized = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = normalized;
  els.themeToggle.textContent = normalized === "dark" ? "Light" : "Dark";
  els.themeToggle.title = normalized === "dark" ? "Switch to light mode" : "Switch to dark mode";
  els.themeToggle.setAttribute("aria-label", els.themeToggle.title);
}

async function scanActivePage() {
  setStatus("Scanning current page...");
  setBusy(true);
  resetProgress();
  state.failedFiles = [];
  renderFailures();

  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isSupportedUrl(tab.url)) {
      throw new Error("Open a PESU Academy page before scanning.");
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE_V3" });

    if (response?.error) {
      throw new Error(response.error);
    }

    state.files = Array.isArray(response?.files) ? response.files : [];
    renderFiles();
    setStatus(state.files.length ? `Found ${state.files.length} downloadable item(s).` : "No downloadable items found on this page.");
  } catch (error) {
    state.files = [];
    renderFiles();
    setStatus(error.message || "Unable to scan this page.");
  } finally {
    setBusy(false);
  }
}

async function downloadSelected() {
  const selected = getSelectedFiles();
  if (!selected.length) {
    setStatus("Select at least one file first.");
    return;
  }
  await startDownloads(selected);
}

async function downloadAllAsZip() {
  if (!state.files.length || state.active) {
    return;
  }

  const prefix = getFolderPrefix();
  chrome.storage.local.set({ folderPrefix: prefix });

  state.failedFiles = [];
  renderFailures();
  state.completed = 0;
  state.total = state.files.length;
  state.active = true;
  els.progress.max = Math.max(state.files.length, 1);
  els.progress.value = 0;
  setStatus(`Building ZIP with ${state.files.length} item(s)...`);
  setBusy(true);

  try {
    await chrome.runtime.sendMessage({
      type: "START_ZIP_DOWNLOAD",
      payload: {
        files: state.files,
        zipName: `${sanitizeZipName(prefix)}.zip`
      }
    });
  } catch (error) {
    state.active = false;
    setBusy(false);
    setStatus(error.message || "Unable to create ZIP.");
  }
}

async function startDownloads(files) {
  if (!files.length || state.active) {
    return;
  }

  const prefix = getFolderPrefix();
  chrome.storage.local.set({ folderPrefix: prefix });

  state.failedFiles = [];
  renderFailures();
  state.completed = 0;
  state.total = files.length;
  state.active = true;
  els.progress.max = Math.max(files.length, 1);
  els.progress.value = 0;
  setStatus(`Starting ${files.length} download(s)...`);
  setBusy(true);

  try {
    await chrome.runtime.sendMessage({
      type: "START_DOWNLOADS",
      payload: {
        prefix,
        files
      }
    });
  } catch (error) {
    state.active = false;
    setBusy(false);
    setStatus(error.message || "Unable to start downloads.");
  }
}

function updateProgress(payload) {
  if (!payload) {
    return;
  }

  if (payload.status === "started") {
    state.completed = 0;
    state.total = payload.total || 0;
    els.progress.max = Math.max(state.total, 1);
    els.progress.value = 0;
    setStatus(`Downloading ${state.total} item(s)...`);
    return;
  }

  if (payload.status === "item") {
    state.completed = payload.completed || state.completed;
    state.total = payload.total || state.total;
    els.progress.max = Math.max(state.total, 1);
    els.progress.value = payload.processed || state.completed;
    setStatus(`${state.completed}/${state.total}: ${payload.fileName || "Downloaded item"}`);
    return;
  }

  if (payload.status === "failed") {
    state.failedFiles.push(payload.file);
    els.progress.value = payload.processed || els.progress.value;
    renderFailures();
    setStatus(`Failed: ${payload.file?.name || "download"}`);
    return;
  }

  if (payload.status === "done") {
    state.completed = payload.completed || state.completed;
    state.total = payload.total || state.total;
    els.progress.value = state.completed;
    state.active = false;
    setBusy(false);
    const failed = payload.failed || state.failedFiles.length;
    setStatus(failed ? `Finished with ${failed} failed download(s).` : `Finished ${state.completed} download(s).`);
  }
}

function updateZipProgress(payload) {
  if (!payload) {
    return;
  }

  if (payload.status === "fetching") {
    state.completed = payload.completed || 0;
    state.total = payload.total || state.total;
    els.progress.max = Math.max(state.total, 1);
    els.progress.value = state.completed;
    setStatus(`${state.completed}/${state.total}: adding ${payload.fileName || "file"} to ZIP`);
    return;
  }

  if (payload.status === "packing") {
    setStatus("Packing ZIP...");
    return;
  }

  if (payload.status === "done") {
    els.progress.value = els.progress.max;
    state.active = false;
    setBusy(false);
    setStatus(`ZIP ready: ${payload.zipName || "course-materials.zip"}`);
    return;
  }

  if (payload.status === "failed") {
    state.active = false;
    setBusy(false);
    setStatus(payload.error || "Unable to create ZIP.");
  }
}

function renderFiles() {
  els.fileList.textContent = "";

  if (!state.files.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No files discovered yet.";
    els.fileList.appendChild(empty);
    updateButtons();
    return;
  }

  state.files.forEach((file, index) => {
    const row = document.createElement("label");
    row.className = "file-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);
    checkbox.addEventListener("change", updateButtons);

    const details = document.createElement("div");

    const name = document.createElement("div");
    name.className = "file-name";
    name.textContent = file.name || "Untitled file";

    const meta = document.createElement("div");
    meta.className = "file-meta";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = file.type || "file";

    const path = [file.course, file.unit, file.className].filter(Boolean).join(" / ");
    meta.append(badge, document.createTextNode(path || "Current page"));

    details.append(name, meta);
    row.append(checkbox, details);
    els.fileList.appendChild(row);
  });

  updateButtons();
}

function renderFailures() {
  els.retryFailed.hidden = !state.failedFiles.length;
}

function getSelectedFiles() {
  return Array.from(els.fileList.querySelectorAll("input[type='checkbox']:checked"))
    .map((checkbox) => state.files[Number(checkbox.dataset.index)])
    .filter(Boolean);
}

function updateButtons() {
  const hasFiles = state.files.length > 0;
  const hasSelection = getSelectedFiles().length > 0;
  els.downloadAll.disabled = !hasFiles || state.active;
  els.downloadSelected.disabled = !hasSelection || state.active;
}

function setBusy(isBusy) {
  els.scanPage.disabled = isBusy;
  updateButtons();
}

function setStatus(text) {
  els.status.textContent = text;
}

function resetProgress() {
  els.progress.max = 1;
  els.progress.value = 0;
}

function getFolderPrefix() {
  return (els.folderPrefix.value || DEFAULT_PREFIX).trim() || DEFAULT_PREFIX;
}

function sanitizeZipName(name) {
  return (name || DEFAULT_PREFIX)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim()
    .slice(0, 120) || DEFAULT_PREFIX;
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => resolve(tab));
  });
}

function isSupportedUrl(url) {
  return /^https:\/\/www\.pesuacademy\.com\//i.test(url || "");
}
