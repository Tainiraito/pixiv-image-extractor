// background.js — 后台任务调度、状态持久化与 Chrome 下载管理

importScripts('config.js');

const {
    MAX_JOB_IMAGES,
    ZIP_IMAGES_PER_PART,
    ZIP_BYTES_PER_PART
} = PIXIV_EXTRACTOR_CONFIG;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const JOB_STATE_KEY = 'pixiv_download_job_state';
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'cancelling']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'cancelled', 'error']);

let creatingOffscreenDocument = null;
let jobOperations = Promise.resolve();

// 串行化状态读写及执行器的创建/清理，防止多个弹窗和进度消息互相覆盖。
// 执行器必须先响应消息，再异步上报状态，避免等待本队列造成死锁。
function withJobLock(operation) {
    const result = jobOperations.then(operation);
    jobOperations = result.catch(() => {});
    return result;
}

function startDownloadJob(job) {
    return withJobLock(() => startDownloadJobUnlocked(job));
}

function cancelDownloadJob(jobId) {
    return withJobLock(() => cancelDownloadJobUnlocked(jobId));
}

function updateJobState(update) {
    return withJobLock(() => updateJobStateUnlocked(update));
}

function getRecoverableJobState() {
    return withJobLock(getRecoverableJobStateUnlocked);
}

function closeOffscreenDocumentForJob(jobId) {
    return withJobLock(() => closeOffscreenDocumentForJobUnlocked(jobId));
}

chrome.runtime.onStartup.addListener(() => {
    reconcilePersistedState().catch(error => {
        console.error('[后台任务] 启动状态恢复失败:', error);
    });
});

chrome.runtime.onInstalled.addListener(() => {
    reconcilePersistedState().catch(error => {
        console.error('[后台任务] 安装状态初始化失败:', error);
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'background') return false;

    handleMessage(message, sender)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => {
            console.error('[后台任务] 消息处理失败:', error);
            sendResponse({
                success: false,
                error: getErrorMessage(error, '后台任务处理失败')
            });
        });
    return true;
});

async function handleMessage(message, sender) {
    if (sender.id !== chrome.runtime.id) {
        throw new Error('拒绝处理非本扩展来源的消息');
    }

    switch (message.action) {
        case 'start-download-job':
            assertExtensionPageSender(sender);
            return startDownloadJob(message.job);
        case 'get-download-job':
            assertExtensionPageSender(sender);
            return { state: await getRecoverableJobState() };
        case 'cancel-download-job':
            assertExtensionPageSender(sender);
            return cancelDownloadJob(message.jobId);
        case 'job-status-update':
            assertOffscreenSender(sender);
            return updateJobState(message.update);
        case 'create-browser-download':
            assertOffscreenSender(sender);
            return createBrowserDownload(message.options);
        case 'get-browser-download':
            assertOffscreenSender(sender);
            return getBrowserDownload(message.downloadId);
        case 'close-offscreen-document':
            assertOffscreenSender(sender);
            return closeOffscreenDocumentForJob(message.jobId);
        default:
            throw new Error(`未知后台操作：${message.action || '空'}`);
    }
}

async function startDownloadJobUnlocked(rawJob) {
    const currentState = await getRecoverableJobStateUnlocked();
    if (currentState && ACTIVE_JOB_STATUSES.has(currentState.status)) {
        throw new Error('已有下载任务正在后台运行，请等待完成或先停止当前任务');
    }

    const job = normalizeJob(rawJob);
    const now = Date.now();
    const initialState = {
        jobId: job.jobId,
        type: job.type,
        status: 'starting',
        message: job.type === 'direct' ? '正在启动后台下载...' : '正在启动后台打包...',
        processed: 0,
        total: job.images.length,
        parts: 0,
        failed: 0,
        sequence: 0,
        startedAt: now,
        updatedAt: now
    };

    await saveAndBroadcastJobState(initialState);

    try {
        // 复用仍为已提交下载保留 Blob 的文档，不能在新任务启动时将其关闭。
        await setupOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'start-job',
            job
        });

        if (!response?.accepted) {
            throw new Error(response?.error || '后台执行器未接受任务');
        }
        const runningState = { ...initialState, status: 'running', updatedAt: Date.now() };
        await saveAndBroadcastJobState(runningState);
        return { jobId: job.jobId, state: runningState };
    } catch (error) {
        await saveAndBroadcastJobState({
            ...initialState,
            status: 'error',
            message: getErrorMessage(error, '后台任务启动失败'),
            updatedAt: Date.now()
        });
        await closeOffscreenDocumentForJobUnlocked(job.jobId).catch(() => {});
        throw error;
    }
}

async function cancelDownloadJobUnlocked(jobId) {
    const state = await getJobState();
    if (!state || !ACTIVE_JOB_STATUSES.has(state.status)) {
        return { state };
    }
    if (jobId && state.jobId !== jobId) {
        throw new Error('当前后台任务已经发生变化，请重新打开扩展');
    }

    const cancellingState = {
        ...state,
        status: 'cancelling',
        message: '正在停止后台任务，已创建的下载不会取消',
        updatedAt: Date.now()
    };
    await saveAndBroadcastJobState(cancellingState);

    if (!await hasOffscreenDocument()) {
        const interruptedState = {
            ...cancellingState,
            status: 'error',
            message: '后台执行器已退出，任务已经中断',
            updatedAt: Date.now()
        };
        await saveAndBroadcastJobState(interruptedState);
        return { state: interruptedState };
    }

    await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'cancel-job',
        jobId: state.jobId
    });
    return { state: cancellingState };
}

async function updateJobStateUnlocked(rawUpdate) {
    const currentState = await getJobState();
    if (!currentState || rawUpdate?.jobId !== currentState.jobId) {
        return { ignored: true };
    }
    if (TERMINAL_JOB_STATUSES.has(currentState.status)) {
        return { ignored: true };
    }

    const sequence = normalizeNonNegativeInteger(rawUpdate.sequence, 0);
    if (sequence <= (currentState.sequence || 0)) {
        return { ignored: true };
    }

    let status = ['running', 'cancelling', 'completed', 'cancelled', 'error']
        .includes(rawUpdate.status)
        ? rawUpdate.status
        : currentState.status;
    if (currentState.status === 'cancelling' && status === 'running') {
        status = 'cancelling';
    }

    const keepCancellingMessage = currentState.status === 'cancelling'
        && rawUpdate.status === 'running';
    const nextState = {
        ...currentState,
        status,
        message: String(
            keepCancellingMessage
                ? currentState.message
                : rawUpdate.message || currentState.message
        ).slice(0, 240),
        processed: normalizeNonNegativeInteger(rawUpdate.processed, currentState.processed),
        total: normalizeNonNegativeInteger(rawUpdate.total, currentState.total),
        parts: normalizeNonNegativeInteger(rawUpdate.parts, currentState.parts),
        failed: normalizeNonNegativeInteger(rawUpdate.failed, currentState.failed),
        sequence,
        updatedAt: Date.now()
    };

    await saveAndBroadcastJobState(nextState);
    return { state: nextState, terminal: TERMINAL_JOB_STATUSES.has(nextState.status) };
}

async function getRecoverableJobStateUnlocked() {
    const state = await getJobState();
    if (!state || !ACTIVE_JOB_STATUSES.has(state.status)) return state;
    if (await hasOffscreenDocument()) {
        const executor = await getOffscreenExecutorState();
        if (executor.activeJobId === state.jobId) return state;
    }

    const interruptedState = {
        ...state,
        status: 'error',
        message: '后台任务因浏览器或扩展重启而中断，请重新开始',
        updatedAt: Date.now()
    };
    await saveAndBroadcastJobState(interruptedState);
    return interruptedState;
}

async function saveAndBroadcastJobState(state) {
    await chrome.storage.session.set({ [JOB_STATE_KEY]: state });
    await updateActionBadge(state);

    // 弹窗关闭时没有接收端属于正常情况。
    chrome.runtime.sendMessage({
        target: 'popup',
        action: 'download-job-status',
        state
    }).catch(() => {});
}

async function getJobState() {
    const result = await chrome.storage.session.get(JOB_STATE_KEY);
    return result[JOB_STATE_KEY] || null;
}

async function reconcilePersistedState() {
    const state = await getRecoverableJobState();
    if (state) {
        await updateActionBadge(state);
    } else {
        await chrome.action.setBadgeText({ text: '' });
    }
}

async function updateActionBadge(state) {
    if (ACTIVE_JOB_STATUSES.has(state.status)) {
        const percent = state.total > 0
            ? Math.min(99, Math.floor((state.processed / state.total) * 100))
            : 0;
        await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
        await chrome.action.setBadgeText({ text: String(percent) });
    } else if (state.status === 'error') {
        await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
        await chrome.action.setBadgeText({ text: '!' });
    } else {
        await chrome.action.setBadgeText({ text: '' });
    }
}

async function setupOffscreenDocument() {
    if (await hasOffscreenDocument()) return;

    if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ['BLOBS'],
            justification: '在后台生成分卷 ZIP，并在写入磁盘后释放 Blob 内存'
        }).finally(() => {
            creatingOffscreenDocument = null;
        });
    }
    await creatingOffscreenDocument;
}

async function hasOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
}

async function closeOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
    }
}

async function getOffscreenExecutorState() {
    const response = await chrome.runtime.sendMessage({
        target: 'offscreen',
        action: 'get-executor-state'
    });
    if (!response || !Number.isInteger(response.pendingDownloads)) {
        throw new Error('无法读取后台执行器状态');
    }
    return response;
}

async function closeOffscreenDocumentForJobUnlocked(jobId) {
    const state = await getJobState();
    if (jobId && state?.jobId !== jobId) return { ignored: true };
    if (state && ACTIVE_JOB_STATUSES.has(state.status)) {
        return { ignored: true };
    }
    if (!await hasOffscreenDocument()) return {};
    // 同一文档可能仍持有旧任务的下载；还要确认没有任务及未完成的下载。
    const executor = await getOffscreenExecutorState();
    if (executor.activeJobId || executor.pendingDownloads > 0) {
        return { ignored: true };
    }
    await closeOffscreenDocument();
    return {};
}

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
