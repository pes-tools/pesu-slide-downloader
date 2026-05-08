(() => {
  const SCRIPT_VERSION = "3.0.1";
  const FILE_EXTENSIONS = [
    "pdf",
    "ppt",
    "pptx",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "csv",
    "zip",
    "rar",
    "7z",
    "txt"
  ];

  const PESU_DOWNLOAD_ROUTE = /\/Academy\/a\/referenceMeterials\/downloadslidecoursedoc\/[^"'\s<>]+/i;
  const SALESFORCE_DOWNLOAD_ROUTE = /\/sfc\/servlet\.shepherd\/document\/download\/[^"'\s<>]+/i;
  const ABSOLUTE_URL = /https?:\/\/[^\s"'<>]+/gi;
  const RELATIVE_DOWNLOAD_URL = /\/(?:Academy\/a\/referenceMeterials\/downloadslidecoursedoc|sfc\/servlet\.shepherd\/document\/download)\/[^\s"'<>]+/gi;
  const FILE_EXTENSION_RE = new RegExp(`\\.(${FILE_EXTENSIONS.join("|")})(?:[?#][^\\s"'<>]*)?$`, "i");
  const TABLE_SLIDES_CALL_RE = /handleclasscoursecontentunit\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]?([^,'")]+)['"]?\s*,\s*2\s*,\s*event\s*\)/i;

  if (globalThis.__pesuSlideDownloaderVersion === SCRIPT_VERSION) {
    return;
  }
  globalThis.__pesuSlideDownloaderVersion = SCRIPT_VERSION;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "SCAN_PAGE_V3") {
      scanPage()
        .then((files) => sendResponse({ files }))
        .catch((error) => sendResponse({ files: [], error: error.message }));
      return true;
    }

    return false;
  });

  async function scanPage() {
    const elements = collectElements(document);
    const context = getPageContext();
    const files = [];
    const seen = new Set();

    for (const element of elements) {
      const urls = getElementUrls(element);
      for (const url of urls) {
        if (!isDownloadUrl(url)) {
          continue;
        }

        const normalizedUrl = normalizeDownloadUrl(url);
        if (!normalizedUrl || seen.has(normalizedUrl)) {
          continue;
        }

        seen.add(normalizedUrl);
        const elementContext = getElementContext(element, context);
        const name = inferFileName(normalizedUrl, element, files.length);
        files.push({
          id: makeStableId(normalizedUrl),
          url: normalizedUrl,
          name,
          type: inferFileType(normalizedUrl, name),
          course: elementContext.course,
          unit: elementContext.unit,
          className: elementContext.className,
          sourceText: getVisibleText(element).slice(0, 160)
        });
      }
    }

    const tableFiles = await scanSlidesTable(elements, context, seen);
    files.push(...tableFiles);

    return files;
  }

  async function scanSlidesTable(elements, context, seen) {
    const slideEntries = getSlidesTableEntries(elements, context);
    const files = [];

    for (const entry of slideEntries) {
      const html = await fetchSlidesHtml(entry);
      const parsedFiles = parseFilesFromHtml(html, entry, files.length);

      for (const file of parsedFiles) {
        const normalizedUrl = normalizeDownloadUrl(file.url);
        if (!normalizedUrl || seen.has(normalizedUrl)) {
          continue;
        }

        seen.add(normalizedUrl);
        files.push({
          ...file,
          id: makeStableId(normalizedUrl),
          url: normalizedUrl
        });
      }
    }

    return files;
  }

  function getSlidesTableEntries(elements, pageContext) {
    const entries = [];
    const seen = new Set();

    for (const element of elements) {
      const onclick = element.getAttribute?.("onclick") || "";
      const match = onclick.match(TABLE_SLIDES_CALL_RE);
      if (!match) {
        continue;
      }

      const [, courseunitid, subjectid, coursecontentid, classNo] = match;
      const key = [courseunitid, subjectid, coursecontentid, classNo].join("|");
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      const row = element.closest?.("tr");
      const rowFirstCell = row?.querySelector("td,th");
      const rowClass = rowFirstCell ? getVisibleText(rowFirstCell) : "";
      entries.push({
        courseunitid,
        subjectid,
        coursecontentid,
        classNo,
        menuId: getMenuId(),
        subType: getQueryValue("subType") || "3",
        course: cleanSegment(pageContext.course),
        unit: cleanSegment(pageContext.unit),
        className: cleanSegment(rowClass || pageContext.className)
      });
    }

    return entries;
  }

  async function fetchSlidesHtml(entry) {
    const firstUrl = new URL("/Academy/s/studentProfilePESUAdmin", location.origin);
    firstUrl.searchParams.set("controllerMode", "6403");
    firstUrl.searchParams.set("actionType", "44");
    firstUrl.searchParams.set("courseunitid", entry.courseunitid);
    firstUrl.searchParams.set("subjectid", entry.subjectid);
    firstUrl.searchParams.set("coursecontentid", entry.coursecontentid);
    firstUrl.searchParams.set("classNo", entry.classNo);
    firstUrl.searchParams.set("type", "2");
    firstUrl.searchParams.set("menuId", entry.menuId);
    firstUrl.searchParams.set("subType", entry.subType);
    firstUrl.searchParams.set("_", Date.now().toString());

    await fetch(firstUrl.href, {
      credentials: "include",
      cache: "no-store"
    });

    const secondUrl = new URL("/Academy/s/studentProfilePESUAdmin", location.origin);
    secondUrl.searchParams.set("url", "studentProfilePESUAdmin");
    secondUrl.searchParams.set("controllerMode", "6403");
    secondUrl.searchParams.set("actionType", "60");
    secondUrl.searchParams.set("selectedData", entry.subjectid);
    secondUrl.searchParams.set("id", "2");
    secondUrl.searchParams.set("unitid", entry.courseunitid);
    secondUrl.searchParams.set("menuId", entry.menuId);
    secondUrl.searchParams.set("_", Date.now().toString());

    const response = await fetch(secondUrl.href, {
      credentials: "include",
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`PESU returned ${response.status} while scanning slides.`);
    }

    return response.text();
  }

  function parseFilesFromHtml(html, entry, offset) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const files = [];
    const seen = new Set();
    const elements = Array.from(doc.querySelectorAll("*"));

    for (const element of elements) {
      const urls = getElementUrls(element);
      for (const url of urls) {
        if (!isDownloadUrl(url)) {
          continue;
        }

        const normalizedUrl = normalizeDownloadUrl(url);
        if (!normalizedUrl || seen.has(normalizedUrl)) {
          continue;
        }

        seen.add(normalizedUrl);
        const name = inferFileName(normalizedUrl, element, offset + files.length);
        files.push({
          url: normalizedUrl,
          name,
          type: inferFileType(normalizedUrl, name),
          course: entry.course,
          unit: entry.unit,
          className: entry.className,
          sourceText: getVisibleText(element).slice(0, 160)
        });
      }
    }

    return files;
  }

  function collectElements(root) {
    const elements = [];
    const visitRoot = (currentRoot) => {
      if (!currentRoot) {
        return;
      }

      const rootElement = currentRoot.nodeType === Node.ELEMENT_NODE ? currentRoot : currentRoot.documentElement;
      if (rootElement) {
        elements.push(rootElement);
      }

      const found = currentRoot.querySelectorAll ? Array.from(currentRoot.querySelectorAll("*")) : [];
      for (const element of found) {
        elements.push(element);
        if (element.shadowRoot) {
          visitRoot(element.shadowRoot);
        }
      }
    };

    visitRoot(root);
    return elements;
  }

  function getElementUrls(element) {
    const values = new Set();

    for (const attribute of Array.from(element.attributes || [])) {
      if (looksRelevantAttribute(attribute.name, attribute.value)) {
        extractUrlsFromText(attribute.value).forEach((url) => values.add(url));
      }
    }

    if (element instanceof HTMLAnchorElement && element.href) {
      values.add(element.href);
    }

    if ((element instanceof HTMLIFrameElement || element instanceof HTMLEmbedElement || element instanceof HTMLObjectElement) && element.src) {
      values.add(element.src);
    }

    const text = getVisibleText(element);
    if (text.includes("downloadslidecoursedoc") || text.includes("servlet.shepherd")) {
      extractUrlsFromText(text).forEach((url) => values.add(url));
    }

    return Array.from(values);
  }

  function looksRelevantAttribute(name, value) {
    if (!value) {
      return false;
    }

    const lowerName = name.toLowerCase();
    const lowerValue = value.toLowerCase();
    return (
      ["href", "src", "data-href", "data-url", "data-src", "data-download-url", "data-file-url", "onclick", "value"].includes(lowerName) ||
      lowerName.includes("url") ||
      lowerName.includes("href") ||
      lowerName.includes("download") ||
      lowerValue.includes("downloadslidecoursedoc") ||
      lowerValue.includes("servlet.shepherd") ||
      FILE_EXTENSION_RE.test(stripUrlNoise(lowerValue))
    );
  }

  function extractUrlsFromText(text) {
    const urls = [];
    const decoded = decodeHtmlEntities(String(text || ""));

    for (const match of decoded.matchAll(ABSOLUTE_URL)) {
      urls.push(cleanCandidateUrl(match[0]));
    }

    for (const match of decoded.matchAll(RELATIVE_DOWNLOAD_URL)) {
      urls.push(cleanCandidateUrl(new URL(match[0], location.origin).href));
    }

    const routeMatch = decoded.match(PESU_DOWNLOAD_ROUTE) || decoded.match(SALESFORCE_DOWNLOAD_ROUTE);
    if (routeMatch) {
      urls.push(cleanCandidateUrl(new URL(routeMatch[0], location.origin).href));
    }

    return urls.filter(Boolean);
  }

  function isDownloadUrl(url) {
    const cleaned = stripUrlNoise(url);
    return (
      PESU_DOWNLOAD_ROUTE.test(cleaned) ||
      SALESFORCE_DOWNLOAD_ROUTE.test(cleaned) ||
      FILE_EXTENSION_RE.test(cleaned.split("?")[0].split("#")[0])
    );
  }

  function normalizeDownloadUrl(url) {
    try {
      const parsed = new URL(cleanCandidateUrl(url), location.href);
      if (parsed.hostname === "www.pesuacademy.com" && parsed.pathname.includes("/downloadslidecoursedoc/")) {
        parsed.hash = "";
      }
      return parsed.href;
    } catch (error) {
      return "";
    }
  }

  function cleanCandidateUrl(url) {
    return stripUrlNoise(url)
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&")
      .replace(/[),.;]+$/g, "");
  }

  function stripUrlNoise(url) {
    return String(url || "").trim().replace(/^['"]+|['"]+$/g, "");
  }

  function decodeHtmlEntities(text) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  function inferFileName(url, element, index) {
    const urlName = getFileNameFromUrl(url);
    const textName = cleanFileName(getVisibleText(element));
    const titleName = cleanFileName(element.getAttribute?.("title") || element.getAttribute?.("aria-label") || "");

    if (urlName) {
      return urlName;
    }

    if (titleName && titleName.length > 2) {
      return addExtensionIfMissing(titleName, url);
    }

    if (textName && textName.length > 2 && textName.length < 100) {
      return addExtensionIfMissing(textName, url);
    }

    const type = inferFileType(url, "");
    return `download-${index + 1}.${type === "file" ? "pdf" : type}`;
  }

  function getFileNameFromUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      const disposition = parsed.searchParams.get("response-content-disposition") || "";
      const dispositionName = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1];
      if (dispositionName) {
        return cleanFileName(decodeURIComponent(dispositionName));
      }

      const lastPart = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
      if (FILE_EXTENSION_RE.test(lastPart)) {
        return cleanFileName(lastPart);
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function addExtensionIfMissing(name, url) {
    const cleanName = cleanFileName(name);
    if (/\.[a-z0-9]{2,5}$/i.test(cleanName)) {
      return cleanName;
    }
    const type = inferFileType(url, cleanName);
    return `${cleanName}.${type === "file" ? "pdf" : type}`;
  }

  function inferFileType(url, name) {
    const source = `${name || ""} ${url || ""}`;
    const match = source.match(new RegExp(`\\.(${FILE_EXTENSIONS.join("|")})(?:[?#\\s]|$)`, "i"));
    return match ? match[1].toLowerCase() : "file";
  }

  function cleanFileName(name) {
    return String(name || "")
      .replace(/\s+/g, " ")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\.+$/g, "")
      .trim()
      .slice(0, 140);
  }

  function getPageContext() {
    const crumbs = getBreadcrumbParts();
    const activeTabs = getActiveTabTexts();
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,.slds-page-header__title"))
      .map(getVisibleText)
      .filter(Boolean);

    return {
      course: findCourseName(crumbs, headings),
      unit: activeTabs[0] || findLikelyUnit(crumbs, headings),
      className: crumbs[crumbs.length - 1] || headings[0] || document.title.replace(/\s+-\s+.*$/, "")
    };
  }

  function getMenuId() {
    return getQueryValue("menuId") || findUrlParamInDocument("menuId") || "653";
  }

  function getQueryValue(name) {
    return new URLSearchParams(location.search).get(name) || "";
  }

  function findUrlParamInDocument(name) {
    const pattern = new RegExp(`[?&]${name}=([^&#"'\\s]+)`, "i");
    const match = document.documentElement.innerHTML.match(pattern);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getBreadcrumbParts() {
    const selectors = [
      "lightning-breadcrumbs a",
      ".slds-breadcrumb a",
      ".breadcrumb a",
      "[aria-label*='Breadcrumb' i] a",
      "a[href*='studentProfilePESU']"
    ];
    const parts = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = getVisibleText(element);
        if (text && !parts.includes(text)) {
          parts.push(text);
        }
      }
    }

    const visibleText = document.body?.innerText || "";
    const courseMatch = visibleText.match(/[A-Z]{2}\d{2}[A-Z]{2}\d{3}[A-Z]?\s*:\s*[^\n\r]+/);
    if (courseMatch && !parts.includes(courseMatch[0].trim())) {
      parts.push(courseMatch[0].trim());
    }
    return parts;
  }

  function getActiveTabTexts() {
    const selectors = [
      "[aria-selected='true']",
      ".active",
      ".slds-is-active",
      ".uiTabItem.active"
    ];
    const texts = [];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = getVisibleText(element);
        if (text && text.length < 120 && !texts.includes(text) && !/slides|notes|assignments|qb|qa|mcqs|references/i.test(text)) {
          texts.push(text);
        }
      }
    }
    return texts;
  }

  function findCourseName(crumbs, headings) {
    const sources = [...crumbs, ...headings, document.title];
    const course = sources.find((text) => /[A-Z]{2}\d{2}[A-Z]{2}\d{3}/.test(text));
    return cleanSegment(course?.replace(/^.*?:\s*/, "") || sources.find(Boolean) || "PESU Course");
  }

  function findLikelyUnit(crumbs, headings) {
    const sources = [...crumbs, ...headings];
    return cleanSegment(sources.find((text) => /vector|matrix|orthogonal|eigen|singular|unit/i.test(text)) || "Slides");
  }

  function getElementContext(element, pageContext) {
    const row = element.closest?.("tr");
    const rowFirstCell = row?.querySelector("td,th");
    const rowClass = rowFirstCell ? getVisibleText(rowFirstCell) : "";
    const localHeading = findNearestHeading(element);

    return {
      course: cleanSegment(pageContext.course),
      unit: cleanSegment(localHeading || pageContext.unit),
      className: cleanSegment(rowClass || pageContext.className)
    };
  }

  function findNearestHeading(element) {
    let current = element;
    for (let depth = 0; current && depth < 5; depth += 1) {
      const heading = current.querySelector?.("h1,h2,h3,h4,h5,h6,[role='heading']");
      const text = heading ? getVisibleText(heading) : "";
      if (text && text.length < 160) {
        return text;
      }
      current = current.parentElement;
    }
    return "";
  }

  function cleanSegment(text) {
    return cleanFileName(text).replace(/\.[a-z0-9]{2,5}$/i, "") || "";
  }

  function getVisibleText(element) {
    return String(element?.innerText || element?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function makeStableId(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(index);
      hash |= 0;
    }
    return `file-${Math.abs(hash)}`;
  }
})();
