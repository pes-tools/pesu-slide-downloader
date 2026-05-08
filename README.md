# PESU Slide Downloader

A lightweight Chrome extension for bulk-downloading slide decks and course materials from PESU Academy pages while you are already logged in.

The extension is built with Manifest V3 and vanilla JavaScript. It scans the currently open PESU materials page, finds downloadable resources, and saves them using Chrome's normal download system.

This is intentionally a small utility: no backend, no build step, and no broad crawling beyond the page you are using.

## Install from ZIP

1. Download the latest ZIP from this repository.
2. Extract the ZIP file.
3. Open Chrome and go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted `pesu-slide-downloader-main` folder, the one that contains `manifest.json`.
7. Pin **PESU Slide Downloader** from the extensions menu if you want quick access.


## Unofficial Project

This is an independent, unofficial tool. It is not affiliated with, endorsed by, sponsored by, or maintained by PES University or PES Academy.

The extension icon is intentionally custom and does not use the PES University logo, seal, or official marks.

## Files

- `manifest.json` - Chrome extension manifest.
- `popup.html` - Popup interface.
- `popup.js` - Popup scanning, selection, and progress logic.
- `content.js` - PESU page scanner, including open shadow-root scanning.
- `background.js` - Download queues, ZIP creation, and direct-download path handling.
- `icons/` - Custom unofficial extension icons.

## How to Use

1. Log in to PESU Academy normally.
2. Open the course page.
3. Open the required unit table or a specific unit/class **Slides** page.
4. Click the **PESU Slide Downloader** extension icon.
5. Click **Scan**.
6. Review the discovered files.
7. Optional: change the ZIP name from `CourseMaterials`.
8. Click **Download ZIP** to create and download one ZIP file, or select specific files and click **Download Selected** to use Chrome's direct downloader.

The ZIP contains all files in one flat list. Names are based on the topic order:

```text
1_Introduction and Course Overview.pdf
2_Module Notes and Examples.pdf
```

If one topic has multiple files, they are named like `1_a_Topic.pdf`, `1_b_Topic.pdf`, and so on.

The ZIP filename comes from the ZIP name field, for example `Course_Unit_2.zip`.

## What It Detects

The scanner looks for:

- PESU slide download URLs like `/Academy/a/referenceMeterials/downloadslidecoursedoc/{id}`.
- PESU unit-table slide cells that call `handleclasscoursecontentunit(...)`.
- Salesforce file URLs like `/sfc/servlet.shepherd/document/download/{id}`.
- Direct file links ending in common material extensions such as `.pdf`, `.ppt`, `.pptx`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.zip`, and `.csv`.
- Links inside open shadow roots where Chrome exposes `element.shadowRoot`.
- Download URLs hidden in common attributes such as `href`, `src`, `data-url`, `data-download-url`, and `onclick`.

## Known Limitations

- You must already be logged in to PESU Academy.
- This release scans the current visible page only. If a different course tab or unit has more files, open that page and click **Scan** again.
- On PESU unit tables, the scanner can follow visible Slides cells by requesting PESU's slide-list HTML fragments. It still does not auto-click through every hidden course/unit tab.
- Closed shadow roots cannot be inspected by browser extensions.
- **Download ZIP** creates a single `.zip` archive through the extension background worker. **Download Selected** still downloads files one by one as a fallback.
- ZIP creation must fetch the file bytes before saving. Very large units may take some time and use browser memory while the ZIP is being assembled.
- Some viewer buttons may not expose their real download URL in the DOM until after you open the slide/material page.
- If Chrome is configured to ask where to save each file, Chrome may still prompt during downloads.

## Privacy and Auth Notes

This extension runs locally inside your browser.

It does not:

- ask for your PESU username or password
- collect, store, upload, or sell personal data
- send your files, course data, cookies, or tokens to any third-party server
- use analytics, tracking scripts, telemetry, ads, or external libraries
- require any backend service

It only reads the currently open PESU Academy page when you click **Scan**. For **Download Selected**, it uses `chrome.downloads.download()` with each discovered URL. For **Download ZIP**, it fetches the discovered file bytes in the extension background worker, builds one ZIP locally in your browser memory, and downloads that ZIP.

Your login session stays in Chrome. The extension does not display, export, or copy your cookies.

## Icon

The included icon is a custom document/download mark with blue-orange accents. It avoids official university branding so the project can be shared publicly without implying endorsement.

Source artwork: `icons/icon-source.png`

Chrome uses these PNG files:

- `icons/icon16.png`
- `icons/icon32.png`
- `icons/icon48.png`
- `icons/icon128.png`

