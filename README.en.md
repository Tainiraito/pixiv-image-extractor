# Pixiv Image Extractor

[简体中文](README.md) · English

A Chrome extension for previewing, selecting, and downloading original images from Pixiv artwork pages. Supports background downloads, automatic ZIP splitting, and pausable download tasks.

[Download the latest release](https://github.com/Tainiraito/pixiv-image-extractor/releases/latest) · [Release history](https://github.com/Tainiraito/pixiv-image-extractor/releases) · [Report an issue](https://github.com/Tainiraito/pixiv-image-extractor/issues)

## Features

- Preview images and select them individually or all at once. Expand the gallery to view larger collections.
- Save original images individually or as ZIP archives, automatically split by image count and size.
- Keep downloading after closing the popup or switching tabs. Pause, resume, or retry unfinished work.
- Keep a local task history and customize filenames with templates.

## Installation

Requires **Chrome 116 or later** and a Pixiv account signed in through the browser.

1. Download `pixiv-image-extractor-v<version>.zip` from [Releases](https://github.com/Tainiraito/pixiv-image-extractor/releases/latest).
2. Extract it to a permanent folder.
3. Open `chrome://extensions/` and enable **Developer mode**.
4. Click **Load unpacked** and select the extracted `pixiv-image-extractor` folder containing `manifest.json`.
5. Open a Pixiv artwork page and click the extension icon in the toolbar.

**Updating an existing installation:** replace the files in the original extension folder, click **Reload** on the extensions page, and refresh any open Pixiv artwork pages. Keep the extension folder after installation.

## Usage

The extension interface currently uses Chinese labels.

1. Open `https://www.pixiv.net/artworks/<artwork-id>`.
2. Click the extension icon and select images, or choose **Select all** (全选).
3. Click **Download** (下载) to save individual images, or **Download ZIP** (打包下载) to create an archive. With multiple selected images or expected archive parts, the labels become 逐张下载 or 分卷下载.
4. Check progress in **Download tasks** (下载任务). Use the task-list icon at the top to view all records, or the gear icon to change download settings.

The gallery initially shows up to three rows. For more than nine images, click the ninth tile to expand the full gallery, then collapse it when needed. Collapsing preserves selections, and **Select all** includes hidden images.

## Download tasks

One task runs at a time. Pause or stop the current task before starting another.

| Action | Behavior |
| --- | --- |
| Pause / Resume (暂停 / 继续) | Pause processing and the current browser download. Resume skips images and ZIP parts already saved. |
| Retry (重试) | Download failed or unfinished items while keeping successful downloads. |
| Stop (停止) | Stop further processing. Downloads already handed to the browser continue. |
| × | Remove a finished task record without deleting downloaded files. |

The main view shows up to three unfinished tasks, prioritizing the active task. Successful tasks move to the full list. Records are stored locally and remain available after reopening the popup or browser. If a browser restart interrupts a task, retry its unfinished items.

Up to 50 records are retained. When creating a task at the limit, the oldest successful record is removed automatically. Paused, failed, and partially failed tasks are retained. If no record can be removed automatically, remove a finished task manually first.

## Download settings

Open the gear icon at the top. Changes are saved automatically.

### Filename templates

Default: `pixiv_{id}_{author}_{title}_p{index}`. The file extension is added automatically; leaving the template empty uses the default.

| Placeholder | Value |
| --- | --- |
| `{id}` | Artwork ID |
| `{author}` | Artist name |
| `{title}` | Artwork title |
| `{index}` | Page number |

Example: `{author}-{title}-p{index}` → `Artist-Title-p1.jpg`.

### ZIP splitting

Each archive contains up to 30 images by default. Use the slider to choose 1–100 images, in steps of 1. Each archive also has an approximately 100 MiB size limit, so the actual number of parts may exceed the image-count estimate. Parts are named `_part001.zip`, `_part002.zip`, and so on.

## Support and limitations

- Supports static images on Pixiv artwork pages. Files are saved to the browser's configured download folder.
- Ugoira animation downloads and conversion are not supported.
- Uninstalling the extension or clearing its storage removes local task history. Downloaded files are unaffected.

## Development and feedback

Report problems through [Issues](https://github.com/Tainiraito/pixiv-image-extractor/issues), including the extension version, browser version, reproduction steps, and error details.

<details>
<summary>Source structure and local tests</summary>

Follow the [documentation guide](docs/DOCUMENTATION_GUIDE.md) when writing READMEs and release notes.

The extension uses Manifest V3. `content.js` extracts artwork details; `background.js` and `task-runtime.js` manage tasks; `offscreen.js` downloads images and creates ZIP archives; `popup.js` / `popup.html` provide the interface. Shared configuration lives in `config.js`.

No build step is required. Clone the repository and load it using the installation steps above. Regression tests use the built-in Node.js test runner with no npm dependencies:

```shell
node --test tests/download-lifecycle.test.cjs
```

If the environment prevents spawning test processes, use Node.js 24:

```shell
node --test --test-isolation=none tests/download-lifecycle.test.cjs
```

Tests simulate Chrome APIs and image responses and inspect ZIP contents. They cover task concurrency, history, pause/resume, retries, and resource cleanup. They do not replace validation in a real browser signed in to Pixiv.

</details>
