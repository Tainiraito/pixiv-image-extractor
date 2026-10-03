// background.js — 后台入口与下载参数校验
importScripts('config.js');
importScripts('messages.js');
importScripts('task-runtime.js');

function createBrowserDownload(rawOptions) {
    const options = normalizeDownloadOptions(rawOptions);

    return new Promise((resolve, reject) => {
        chrome.downloads.download(options, downloadId => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }
            if (!Number.isInteger(downloadId)) {
                reject(PixivMessages.error('error.createDownload'));
                return;
            }
            resolve({ downloadId });
        });
    });
}

function getBrowserDownload(downloadId) {
    if (!Number.isInteger(downloadId)) {
        throw PixivMessages.error('error.downloadId');
    }

    return new Promise((resolve, reject) => {
        chrome.downloads.search({ id: downloadId }, items => {
            const error = chrome.runtime.lastError;
            if (error) {
                reject(new Error(error.message));
                return;
            }

            const item = items?.[0];
            resolve({
                download: item ? {
                    id: item.id,
                    state: item.state,
                    paused: !!item.paused,
                    error: item.error || null,
                    bytesReceived: item.bytesReceived,
                    totalBytes: item.totalBytes
                } : null
            });
        });
    });
}

function normalizeJob(rawJob) {
    if (!rawJob || !['direct', 'zip'].includes(rawJob.type)) {
        throw PixivMessages.error('error.jobType');
    }
    if (!Array.isArray(rawJob.images)
        || rawJob.images.length === 0
        || rawJob.images.length > MAX_JOB_IMAGES) {
        throw PixivMessages.error('error.imageLimit', { max: MAX_JOB_IMAGES });
    }

    const images = rawJob.images.map((image, arrayIndex) => {
        const normalized = {
            index: normalizePositiveInteger(image.index, arrayIndex + 1),
            url: validatePximgUrl(image.url)
        };

        if (rawJob.type === 'direct') {
            normalized.filename = validateFilename(image.filename);
        } else {
            normalized.extension = validateExtension(image.extension);
        }
        return normalized;
    });

    const job = {
        jobId: crypto.randomUUID(),
        type: rawJob.type,
        images
    };

    if (rawJob.type === 'zip') {
        job.archiveName = validateFilename(rawJob.archiveName);
        job.maxImagesPerPart = Math.min(
            ZIP_IMAGES_PER_PART.MAX,
            Math.max(
                ZIP_IMAGES_PER_PART.MIN,
                normalizePositiveInteger(
                    rawJob.maxImagesPerPart,
                    ZIP_IMAGES_PER_PART.DEFAULT
                )
            )
        );
        job.maxBytesPerPart = Math.min(
            ZIP_BYTES_PER_PART.MAX,
            Math.max(
                ZIP_BYTES_PER_PART.MIN,
                normalizePositiveInteger(
                    rawJob.maxBytesPerPart,
                    ZIP_BYTES_PER_PART.DEFAULT
                )
            )
        );
    }
    return job;
}

function normalizeDownloadOptions(rawOptions) {
    const url = String(rawOptions?.url || '');
    const extensionOrigin = `blob:${chrome.runtime.getURL('')}`;
    if (!url.startsWith(extensionOrigin)) {
        throw PixivMessages.error('error.blob');
    }

    return {
        url,
        filename: validateFilename(rawOptions?.filename),
        conflictAction: 'uniquify',
        saveAs: false
    };
}

function validatePximgUrl(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw PixivMessages.error('error.pximg');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.pximg.net') {
        throw PixivMessages.error('error.pximgHost');
    }
    return parsed.href;
}

function validateFilename(filename) {
    const value = String(filename || '').trim();
    if (!value || value.length > 220 || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value)) {
        throw PixivMessages.error('error.filename');
    }
    return value;
}

function validateExtension(extension) {
    const value = String(extension || '').toLowerCase();
    return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(value) ? value : 'jpg';
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function assertExtensionPageSender(sender) {
    const extensionRoot = chrome.runtime.getURL('');
    if (!sender.url?.startsWith(extensionRoot)) {
        throw PixivMessages.error('error.extensionPage');
    }
}

function assertOffscreenSender(sender) {
    if (sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)) {
        throw PixivMessages.error('error.executorOnly');
    }
}

function getErrorMessage(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message ? message.slice(0, 240) : fallback;
}
