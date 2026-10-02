// offscreen.js — 可暂停、续传的下载执行器；已提交下载独立持有 Blob
const DOWNLOAD_POLL_INTERVAL_MS = 500;
let activeJob = null;
let completingJobId = null;
const pendingDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'offscreen') return false;
    if (message.action === 'get-executor-state') {
        sendResponse({ activeJobId: activeJob?.job.jobId || completingJobId,
            pendingDownloads: pendingDownloads.size });
        return false;
    }
    if (message.action === 'start-job') {
        if (activeJob) {
            sendResponse({ accepted: false, error: '后台执行器已有任务正在运行' });
            return false;
        }
        const job = message.job;
        const checkpoint = structuredClone(job.checkpoint);
        const context = { job, checkpoint, completed: new Set(checkpoint.completed),
            failed: new Set(checkpoint.failed), controller: new AbortController(), sequence: 0,
            intent: null, control: Promise.resolve() };
        activeJob = context;
        sendResponse({ accepted: true });
        queueMicrotask(() => runJob(context).catch(error => console.error('[任务执行]', error)));
        return false;
    }
    if (['pause-job', 'cancel-job'].includes(message.action)) {
        if (activeJob?.job.jobId === message.jobId) {
            const context = activeJob;
            context.intent = message.action === 'pause-job' ? 'pause' : 'cancel';
            context.controller.abort();
            if (context.intent === 'pause') {
                context.control = Promise.all([...pendingDownloads.values()]
                    .filter(entry => entry.jobId === message.jobId)
                    .map(entry => setDownloadPaused(entry.downloadId, true)));
                // runJob 会处理该错误；此处提前附加处理器，避免未处理拒绝。
                context.control.catch(() => {});
            }
        }
        sendResponse({ accepted: true });
        return false;
    }
    if (message.action === 'cancel-paused-job') {
        sendResponse({ accepted: true });
        Promise.all([...pendingDownloads.values()].filter(entry => entry.jobId === message.jobId)
            .map(entry => setDownloadPaused(entry.downloadId, false))).catch(console.error);
        return false;
    }
    return false;
});

function checkpointFor(context) {
    return { ...context.checkpoint, completed: [...context.completed], failed: [...context.failed] };
}
function progressFor(context) {
    return { processed: context.completed.size + context.failed.size, total: context.job.images.length,
        failed: context.failed.size, parts: context.checkpoint.nextPart - 1
            + (context.checkpoint.pendingUnit?.partNumber ? 1 : 0), checkpoint: checkpointFor(context) };
}
async function runJob(context) {
    let error = null;
    try {
        await restorePendingUnit(context);
        if (!context.controller.signal.aborted) {
            await (context.job.type === 'direct' ? runDirectJob(context) : runZipJob(context));
        }
    } catch (caught) {
        if (!context.controller.signal.aborted) error = caught;
    }
    try { await context.control; } catch (caught) { error = caught; }
    let status, message;
    if (error) {
        status = 'error';
        message = error.message || '下载失败，可重试';
    } else if (context.intent === 'pause') {
        status = 'paused';
        message = '已暂停，继续时跳过已保存的图片';
    } else if (context.intent === 'cancel') {
        status = 'cancelled';
        message = '已停止，已提交下载继续执行';
    } else {
        status = 'completed';
        message = context.failed.size
            ? '已处理 ' + context.job.images.length + ' 张，' + context.failed.size + ' 张失败，可重试'
            : context.job.type === 'zip'
                ? '打包完成：' + context.completed.size + ' 张图片，共 ' + (context.checkpoint.nextPart - 1) + ' 个 ZIP'
                : '已下载 ' + context.completed.size + ' 张图片';
    }
    completingJobId = context.job.jobId;
    activeJob = null;
    try {
        await reportStatus(context, status, message);
    } finally {
        if (completingJobId === context.job.jobId) completingJobId = null;
        await requestIdleClose();
    }
}
async function runDirectJob(context) {
    for (let index = 0; index < context.job.images.length; index++) {
        if (context.controller.signal.aborted) break;
        if (context.completed.has(index) || context.failed.has(index)) continue;
        const image = context.job.images[index];
        try {
            await reportStatus(context, 'running', '正在读取原图 ' + (index + 1) + '/' + context.job.images.length);
            const blob = await fetchImageBlob(context, image.url);
            if (context.controller.signal.aborted) break;
            const unit = { indices: [index], partNumber: 0 };
            const complete = await submitUnit(context, blob, unit, image.filename);
            if (!complete) break;
            commitUnit(context, unit);
        } catch (error) {
            if (context.controller.signal.aborted) throw error;
            context.failed.add(index);
            context.checkpoint.pendingUnit = null;
        }
        await reportStatus(context, 'running', '已处理 ' + (context.completed.size + context.failed.size)
            + '/' + context.job.images.length + ' 张');
        await delay(100);
    }
}
function commitUnit(context, unit) {
    for (const index of unit.indices) {
        context.completed.add(index);
        context.failed.delete(index);
    }
    if (unit.partNumber) context.checkpoint.nextPart = unit.partNumber + 1;
    context.checkpoint.pendingUnit = null;
}
async function restorePendingUnit(context) {
    const unit = context.checkpoint.pendingUnit;
    if (!unit) return;
    let entry = pendingDownloads.get(unit.downloadId);
    const { download } = await sendBackgroundRequest('get-browser-download', { downloadId: unit.downloadId });
    if (download?.state === 'complete') {
        commitUnit(context, unit);
        return;
    }
    if (!download || download.state === 'interrupted') {
        context.checkpoint.pendingUnit = null;
        if (context.job.retry) return; // 已完成检查点不变，重新构建未完成的部分。
        for (const index of unit.indices) context.failed.add(index);
        throw new Error('之前的下载已中断，请点击重试');
    }
    if (!entry) {
        entry = { downloadId: unit.downloadId, blobUrl: null, jobId: context.job.jobId };
        pendingDownloads.set(unit.downloadId, entry);
        entry.completion = monitorBrowserDownload(entry);
    }
    await setDownloadPaused(unit.downloadId, false);
    await reportStatus(context, 'running', '正在继续之前的下载…');
    if (await waitForBrowserDownload(context, entry)) commitUnit(context, unit);
}
function createBundle(job) {
    const zip = new JSZip();
    return { zip, folder: zip.folder(job.archiveName), indices: [], bytes: 0 };
}
async function runZipJob(context) {
    const job = context.job;
    let bundle = createBundle(job);
    for (let index = 0; index < job.images.length; index++) {
        if (context.controller.signal.aborted) return;
        if (context.completed.has(index) || context.failed.has(index)) continue;
        if (bundle.indices.length >= job.maxImagesPerPart) {
            if (!await flushBundle(context, bundle, true)) return;
            bundle = createBundle(job);
        }
        await reportStatus(context, 'running', '正在读取原图 ' + (index + 1) + '/' + job.images.length);
        let blob;
        try { blob = await fetchImageBlob(context, job.images[index].url); }
        catch (error) {
            if (!context.controller.signal.aborted) context.failed.add(index);
            throw error;
        }
        if (context.controller.signal.aborted) return;
        if (bundle.indices.length && bundle.bytes + blob.size > job.maxBytesPerPart) {
            if (!await flushBundle(context, bundle, true)) return;
            bundle = createBundle(job);
        }
        const image = job.images[index];
        bundle.folder.file('p' + image.index + '.' + image.extension, blob, { binary: true, compression: 'STORE' });
        bundle.indices.push(index);
        bundle.bytes += blob.size;
    }
    if (!context.controller.signal.aborted && bundle.indices.length) await flushBundle(context, bundle, false);
}
async function flushBundle(context, bundle, hasMore) {
    const partNumber = context.checkpoint.nextPart;
    await reportStatus(context, 'running', '正在生成 ZIP（' + bundle.indices.length + ' 张）…');
    let lastPercent = -10;
    const blob = await bundle.zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' }, metadata => {
        const percent = Math.round(metadata.percent || 0);
        if (percent - lastPercent < 10) return;
        lastPercent = percent;
        reportStatus(context, 'running', '正在生成 ZIP ' + percent + '%').catch(() => {});
    });
    if (context.controller.signal.aborted) return false;
    const numbered = hasMore || partNumber > 1;
    const filename = context.job.archiveName + (numbered ? '_part' + String(partNumber).padStart(3, '0') : '') + '.zip';
    const unit = { indices: bundle.indices.slice(), partNumber };
    if (!await submitUnit(context, blob, unit, filename)) return false;
    commitUnit(context, unit);
    return true;
}
async function submitUnit(context, blob, unit, filename) {
    const blobUrl = URL.createObjectURL(blob);
    let downloadId;
    try {
        ({ downloadId } = await sendBackgroundRequest('create-browser-download', { options: { url: blobUrl, filename } }));
    } catch (error) {
        URL.revokeObjectURL(blobUrl);
        throw error;
    }
    unit.downloadId = downloadId;
    context.checkpoint.pendingUnit = unit;
    const entry = { downloadId, blobUrl, jobId: context.job.jobId };
    pendingDownloads.set(downloadId, entry);
    entry.completion = monitorBrowserDownload(entry);
    // 处理暂停恰好发生在 Chrome 创建下载回调之前的情况。
    if (context.intent === 'pause') await setDownloadPaused(downloadId, true);
    await reportStatus(context, 'running', context.job.type === 'zip' ? '正在写入 ZIP…' : '正在保存图片…');
    return waitForBrowserDownload(context, entry);
}
async function fetchImageBlob(context, url) {
    const response = await fetch(url, { signal: context.controller.signal });
    if (!response.ok) throw new Error('图片请求失败：HTTP ' + response.status);
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) throw new Error('图片响应类型异常：' + contentType);
    return response.blob();
}
async function setDownloadPaused(downloadId, paused) {
    const { download } = await sendBackgroundRequest('get-browser-download', { downloadId });
    if (!download || download.state !== 'in_progress' || !!download.paused === paused) return;
    try {
        await sendBackgroundRequest('control-browser-download', { downloadId, operation: paused ? 'pause' : 'resume' });
    } catch (error) {
        const current = await sendBackgroundRequest('get-browser-download', { downloadId });
        if (current.download?.state === 'in_progress') throw error;
    }
}
async function waitForBrowserDownload(context, entry) {
    const signal = context.controller.signal;
    if (signal.aborted) return false;
    let onAbort;
    const cancelled = new Promise(resolve => {
        onAbort = () => resolve({ cancelled: true });
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        const outcome = await Promise.race([entry.completion, cancelled]);
        if (outcome.cancelled) return false;
        if (outcome.error) throw new Error('下载中断：' + outcome.error);
        return true;
    } finally { signal.removeEventListener('abort', onAbort); }
}
async function monitorBrowserDownload(entry) {
    while (true) {
        try {
            const { download } = await sendBackgroundRequest('get-browser-download', { downloadId: entry.downloadId });
            if (download?.state === 'complete' || download?.state === 'interrupted') {
                if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
                pendingDownloads.delete(entry.downloadId);
                requestIdleClose();
                return { error: download.state === 'interrupted' ? download.error || '未知原因' : null };
            }
        } catch (error) { console.error('[下载监控]', error); }
        await delay(DOWNLOAD_POLL_INTERVAL_MS);
    }
}
async function requestIdleClose() {
    if (activeJob || completingJobId || pendingDownloads.size > 0) return;
    try { await sendBackgroundRequest('close-offscreen-document'); } catch {}
}
async function reportStatus(context, status, message) {
    await sendBackgroundRequest('job-status-update', { update: {
        jobId: context.job.jobId, runId: context.job.runId, sequence: ++context.sequence,
        status, message, ...progressFor(context)
    } });
}
async function sendBackgroundRequest(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ target: 'background', action, ...payload });
    if (!response?.success) throw new Error(response?.error || '后台服务无响应');
    return response;
}
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
