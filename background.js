// background.js — 后台入口与下载参数校验
importScripts('config.js');
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
                reject(new Error('Chrome 未能创建下载任务'));
                return;
            }
            resolve({ downloadId });
        });
    });
}

function getBrowserDownload(downloadId) {
    if (!Number.isInteger(downloadId)) {
        throw new Error('下载任务 ID 无效');
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
        throw new Error('下载任务类型无效');
    }
    if (!Array.isArray(rawJob.images)
        || rawJob.images.length === 0
        || rawJob.images.length > MAX_JOB_IMAGES) {
        throw new Error(`任务图片数量必须在 1～${MAX_JOB_IMAGES} 之间`);
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
        throw new Error('后台下载只允许使用本扩展创建的 Blob 地址');
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
        throw new Error('Pixiv 图片地址无效');
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.pximg.net') {
        throw new Error('拒绝下载非 Pixiv 图片域名');
    }
    return parsed.href;
}

function validateFilename(filename) {
    const value = String(filename || '').trim();
    if (!value || value.length > 220 || /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value)) {
        throw new Error('下载文件名无效');
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
        throw new Error('该操作只能由扩展页面发起');
    }
}

function assertOffscreenSender(sender) {
    if (sender.url !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)) {
        throw new Error('该操作只能由后台执行器发起');
    }
}

function getErrorMessage(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message ? message.slice(0, 240) : fallback;
}
