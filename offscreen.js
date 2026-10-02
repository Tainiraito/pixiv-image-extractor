// offscreen.js — 在隐藏文档中执行可跨标签页持续运行的下载与 ZIP 任务

const DOWNLOAD_SCHEDULE_INTERVAL_MS = 100;
const DOWNLOAD_POLL_INTERVAL_MS = 500;

let activeJob = null;
let completingJobId = null;
let cancelRequested = false;
let statusSequence = 0;
let jobAbortController = null;
const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return false;

    if (message.action === 'get-executor-state') {
        sendResponse({
            activeJobId: activeJob?.jobId || completingJobId,
            pendingDownloads: pendingDownloads.size
        });
        return false;
    }

    if (message.action === 'start-job') {
        if (activeJob) {
            sendResponse({ accepted: false, error: '后台执行器已有任务正在运行' });
            return false;
        }

        activeJob = message.job;
        cancelRequested = false;
        statusSequence = 0;
        jobAbortController = new AbortController();
        sendResponse({ accepted: true });

        // 先响应 Service Worker，再开始耗时任务，避免启动消息通道被长期占用。
        queueMicrotask(() => runJob(message.job).catch(error => {
            console.error('[后台执行器] 任务状态上报失败:', error);
        }));
        return false;
    }

    if (message.action === 'cancel-job' && activeJob?.jobId === message.jobId) {
        cancelRequested = true;
        jobAbortController?.abort();
        sendResponse({ accepted: true });
        return false;
    }

    return false;
});

async function runJob(job) {
    let result = {
        processed: 0,
        total: job.images.length,
        parts: 0,
        failed: 0
    };
    let finalUpdate;

    try {
        await (job.type === 'direct'
            ? runDirectDownloadJob(job, result)
            : runZipDownloadJob(job, result));

        if (cancelRequested) {
            const message = job.type === 'direct'
                ? `已停止：处理 ${result.processed}/${result.total} 个下载任务`
                : `已停止：处理 ${result.processed}/${result.total} 张，生成 ${result.parts} 个 ZIP`;
            finalUpdate = {
                ...result,
                status: 'cancelled',
                message
            };
        } else {
            const message = job.type === 'direct'
                ? result.failed > 0
                    ? `后台任务完成：${result.processed - result.failed} 张下载完成，${result.failed} 张失败`
                    : `已下载 ${result.processed} 张图片`
                : `后台打包完成：${result.processed} 张图片，共 ${result.parts} 个 ZIP`;

            finalUpdate = {
                ...result,
                status: 'completed',
                message
            };
        }
    } catch (error) {
        if (cancelRequested || error?.name === 'AbortError') {
            const message = job.type === 'direct'
                ? `已停止：处理 ${result.processed}/${result.total} 个下载任务`
                : `已停止：处理 ${result.processed}/${result.total} 张，生成 ${result.parts} 个 ZIP`;
            finalUpdate = {
                ...result,
                status: 'cancelled',
                message
            };
        } else {
            console.error('[后台执行器] 任务失败:', error);
            finalUpdate = {
                ...result,
                status: 'error',
                message: getErrorMessage(error, '后台任务执行失败')
            };
        }
    } finally {
        completingJobId = job.jobId;
        activeJob = null;
        jobAbortController = null;
        cancelRequested = false;

        // 先释放执行槽再发布终态；新任务可复用文档，旧下载仍由独立监控器持有。
        try {
            await reportStatus(job, finalUpdate);
        } finally {
            if (completingJobId === job.jobId) completingJobId = null;
            await requestIdleClose();
        }
    }
}

async function runDirectDownloadJob(job, result) {
    for (let index = 0; index < job.images.length; index++) {
        if (cancelRequested) break;

        const image = job.images[index];

        try {
            await reportStatus(job, {
                ...result,
                status: 'running',
                message: `正在后台读取原图 ${index + 1}/${job.images.length}...`
            });

            // 先通过带 Pixiv Referer 的 fetch 获取图片，再用同源 Blob 交给下载管理器。
            // 每次只保留一张原图，不会重新引入大型画廊的累计内存问题。
            const blob = await fetchImageBlob(image.url);
            if (cancelRequested) break;
            await downloadImageBlob(blob, image.filename);
        } catch (error) {
            if (cancelRequested || error?.name === 'AbortError') break;
            console.error(`[后台下载] 图片 ${image.index} 下载失败:`, error);
            result.failed++;
        }

        result.processed++;
        await reportStatus(job, {
            ...result,
            status: 'running',
            message: `已处理 ${result.processed}/${result.total} 张下载任务`
        });
        await delay(DOWNLOAD_SCHEDULE_INTERVAL_MS);
    }

    return result;
}

async function downloadImageBlob(blob, filename) {
    const download = await submitBlobDownload(blob, filename);
    await waitForBrowserDownload(download);
}

async function submitBlobDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    try {
        const { downloadId } = await sendBackgroundRequest('create-browser-download', {
            options: { url: blobUrl, filename }
        });
        const entry = { downloadId, blobUrl };
        pendingDownloads.set(downloadId, entry);
        entry.completion = monitorBrowserDownload(downloadId, entry);
        return entry;
    } catch (error) {
        URL.revokeObjectURL(blobUrl);
        throw error;
    }
}

async function runZipDownloadJob(job, result) {
    let bundle = createZipBundle(job.archiveName);

    for (let index = 0; index < job.images.length; index++) {
        if (cancelRequested) break;

        if (bundle.imageCount >= job.maxImagesPerPart) {
            const downloaded = await downloadZipBundle(
                job,
                bundle,
                result.parts + 1,
                true,
                result
            );
            if (downloaded) result.parts++;
            bundle = createZipBundle(job.archiveName);
            if (cancelRequested) break;
        }

        const image = job.images[index];
        await reportStatus(job, {
            ...result,
            status: 'running',
            message: `正在后台读取原图 ${index + 1}/${job.images.length}...`
        });
        const blob = await fetchImageBlob(image.url);
        if (cancelRequested) break;

        if (bundle.imageCount > 0
            && bundle.totalBytes + blob.size > job.maxBytesPerPart) {
            const downloaded = await downloadZipBundle(
                job,
                bundle,
                result.parts + 1,
                true,
                result
            );
            if (downloaded) result.parts++;
            bundle = createZipBundle(job.archiveName);
            if (cancelRequested) break;
        }

        bundle.folder.file(`p${image.index}.${image.extension}`, blob, {
            binary: true,
            compression: 'STORE'
        });
        bundle.imageCount++;
        bundle.totalBytes += blob.size;
        result.processed++;
    }

    if (!cancelRequested && bundle.imageCount > 0) {
        const downloaded = await downloadZipBundle(
            job,
            bundle,
            result.parts + 1,
            result.parts > 0,
            result
        );
        if (downloaded) result.parts++;
    }

    return result;
}

function createZipBundle(folderName) {
    const zip = new JSZip();
    return {
        zip,
        folder: zip.folder(folderName),
        imageCount: 0,
        totalBytes: 0
    };
}

async function downloadZipBundle(job, bundle, partNumber, usePartNumber, result) {
    const partLabel = usePartNumber ? `第 ${partNumber} 卷` : 'ZIP';
    await reportStatus(job, {
        ...result,
        status: 'running',
        message: `正在后台生成${partLabel}（${bundle.imageCount} 张，${formatBytes(bundle.totalBytes)}）...`
    });

    let lastReportedPercent = -10;
    const zipBlob = await bundle.zip.generateAsync({
        type: 'blob',
        streamFiles: true,
        compression: 'STORE'
    }, metadata => {
        const percent = Math.round(metadata.percent || 0);
        if (percent - lastReportedPercent < 10 && percent !== 100) return;
        lastReportedPercent = percent;
        const cancelHint = cancelRequested ? '，完成当前分卷后停止' : '';

        // 进度更新无需阻塞 JSZip；失败时后续关键状态仍会再次上报。
        reportStatus(job, {
            ...result,
            status: cancelRequested ? 'cancelling' : 'running',
            message: `正在后台生成${partLabel} ${percent}%${cancelHint}`
        }).catch(() => {});
    });

    if (cancelRequested) return false;

    const suffix = usePartNumber ? `_part${String(partNumber).padStart(3, '0')}` : '';
    const download = await submitBlobDownload(zipBlob, `${job.archiveName}${suffix}.zip`);

    await reportStatus(job, {
        ...result,
        status: 'running',
        message: `正在后台写入${partLabel}...`
    });
    await waitForBrowserDownload(download);
    return true;
}

async function fetchImageBlob(url) {
    // 使用整个任务的信号，取消发生在进度上报期间时也不会漏掉随后启动的 fetch。
    const response = await fetch(url, { signal: jobAbortController.signal });
    if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        throw new Error(`图片响应类型异常：${contentType}`);
    }
    return await response.blob();
}

async function waitForBrowserDownload(entry) {
    const signal = jobAbortController.signal;
    if (signal.aborted) return false;

    let onAbort;
    const cancelled = new Promise(resolve => {
        onAbort = () => resolve({ cancelled: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const outcome = await Promise.race([entry.completion, cancelled]);
        if (outcome.cancelled) return false;
        if (outcome.error) throw new Error(`下载中断：${outcome.error}`);
        return true;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

// 监控器不受任务取消影响。只有下载真正结束才释放 Blob，暂停期间继续保留。
async function monitorBrowserDownload(downloadId, entry) {
    while (true) {
        try {
            const { download } = await sendBackgroundRequest('get-browser-download', { downloadId });
            if (download?.state === 'complete' || download?.state === 'interrupted') {
                URL.revokeObjectURL(entry.blobUrl);
                pendingDownloads.delete(downloadId);
                // 不等待清理消息，避免与正在等待 completion 的任务形成环形等待。
                requestIdleClose();
                return { error: download.state === 'interrupted' ? download.error || '未知原因' : null };
            }
        } catch (error) {
            // 临时消息/查询失败不能证明下载结束，保留 Blob 并重试。
            console.error('[后台下载] 查询下载状态失败:', error);
        }

        await delay(DOWNLOAD_POLL_INTERVAL_MS);
    }
}

async function requestIdleClose() {
    if (activeJob || completingJobId || pendingDownloads.size > 0) return;
    try {
        await sendBackgroundRequest('close-offscreen-document');
    } catch {
        // 文档关闭可能使消息通道断开。
    }
}

async function reportStatus(job, update) {
    const sequence = ++statusSequence;
    await sendBackgroundRequest('job-status-update', {
        update: { jobId: job.jobId, ...update, sequence }
    });
}

async function sendBackgroundRequest(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({
        target: 'background',
        action,
        ...payload
    });
    if (!response?.success) {
        throw new Error(response?.error || '后台服务无响应');
    }
    return response;
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getErrorMessage(error, fallback) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message ? message.slice(0, 240) : fallback;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
