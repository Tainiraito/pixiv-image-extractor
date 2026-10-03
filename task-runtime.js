// task-runtime.js — 串行调度、任务历史与续传检查点
const { MAX_JOB_IMAGES, ZIP_IMAGES_PER_PART, ZIP_BYTES_PER_PART } = PIXIV_EXTRACTOR_CONFIG;
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const JOB_STATE_KEY = 'pixiv_download_job_state'; // 兼容旧版本
const TASK_STORE_KEY = 'pixiv_download_tasks';
const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'pausing', 'cancelling']);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'cancelled', 'error']);
let creatingOffscreenDocument = null;
let jobOperations = Promise.resolve();

function withJobLock(operation) {
    const result = jobOperations.then(operation);
    jobOperations = result.catch(() => {});
    return result;
}
function startDownloadJob(job) { return withJobLock(() => startDownloadJobUnlocked(job)); }
function cancelDownloadJob(jobId) { return withJobLock(() => interruptJobUnlocked(jobId, 'cancel')); }
function pauseDownloadJob(jobId) { return withJobLock(() => interruptJobUnlocked(jobId, 'pause')); }
function updateJobState(update) { return withJobLock(() => updateJobStateUnlocked(update)); }
function getRecoverableJobState() {
    return withJobLock(async () => currentState(await recoverTasksUnlocked()));
}
function closeOffscreenDocumentForJob(jobId) {
    return withJobLock(() => closeOffscreenDocumentForJobUnlocked(jobId));
}

chrome.runtime.onStartup.addListener(() => reconcilePersistedState().catch(console.error));
chrome.runtime.onInstalled.addListener(() => reconcilePersistedState().catch(console.error));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'background') return false;
    handleMessage(message, sender)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message, ...PixivMessages.describe(error, 'error.processing') }));
    return true;
});

async function handleMessage(message, sender) {
    if (sender.id !== chrome.runtime.id) throw PixivMessages.error('error.sender');
    if (['job-status-update', 'create-browser-download', 'get-browser-download',
        'control-browser-download', 'close-offscreen-document'].includes(message.action)) {
        assertOffscreenSender(sender);
    } else {
        assertExtensionPageSender(sender);
    }
    switch (message.action) {
        case 'start-download-job': return startDownloadJob(message.job);
        case 'get-download-job': return withJobLock(async () => {
            const store = await recoverTasksUnlocked();
            return { state: publicState(currentState(store)), ...publicStore(store) };
        });
        case 'list-download-jobs': return withJobLock(async () => publicStore(await recoverTasksUnlocked()));
        case 'pause-download-job': return pauseDownloadJob(message.jobId);
        case 'cancel-download-job': return cancelDownloadJob(message.jobId);
        case 'resume-download-job':
        case 'retry-download-job': return withJobLock(() =>
            resumeJobUnlocked(message.jobId, message.action === 'retry-download-job'));
        case 'dismiss-download-job': return withJobLock(() => dismissJobUnlocked(message.jobId));
        case 'job-status-update': return updateJobState(message.update);
        case 'create-browser-download': return createBrowserDownload(message.options);
        case 'get-browser-download': return getBrowserDownload(message.downloadId);
        case 'control-browser-download': return controlBrowserDownload(message.downloadId, message.operation);
        case 'close-offscreen-document': return closeOffscreenDocumentForJob(message.jobId);
        default: throw PixivMessages.error('error.action', { action: message.action || '' });
    }
}

async function getTaskStore() {
    const result = await chrome.storage.local.get(TASK_STORE_KEY);
    if (result[TASK_STORE_KEY]) return result[TASK_STORE_KEY];
    const legacy = await chrome.storage.session.get(JOB_STATE_KEY);
    const state = legacy[JOB_STATE_KEY];
    return { revision: 0, tasks: state ? [{ ...state, title: '', titleKey: 'task.legacyTitle', job: null }] : [] };
}
function currentState(store) {
    return store.tasks.find(task => ACTIVE_JOB_STATUSES.has(task.status)) || store.tasks[0] || null;
}
function publicState(task) {
    if (!task) return null;
    const { job, checkpoint, ...state } = task;
    return { ...state, canResume: !!job && task.status === 'paused',
        canRetry: !!job && (['error', 'cancelled'].includes(task.status)
            || (task.status === 'completed' && task.failed > 0)) };
}
function publicStore(store) {
    return { tasks: store.tasks.map(publicState), revision: store.revision };
}
async function saveTaskStore(store) {
    store.revision = (store.revision || 0) + 1;
    await chrome.storage.local.set({ [TASK_STORE_KEY]: store });
    const state = currentState(store);
    await chrome.storage.session.set({ [JOB_STATE_KEY]: state });
    await updateActionBadge(state);
    chrome.runtime.sendMessage({ target: 'popup', action: 'download-jobs-status', ...publicStore(store) })
        .catch(() => {});
}
function findTask(store, jobId) {
    const task = store.tasks.find(item => item.jobId === jobId);
    if (!task) throw PixivMessages.error('error.removed');
    return task;
}
function emptyCheckpoint() {
    return { completed: [], failed: [], pendingUnit: null, nextPart: 1 };
}
function normalizeCheckpoint(raw, total) {
    const indices = values => [...new Set(Array.isArray(values) ? values : [])]
        .filter(index => Number.isInteger(index) && index >= 0 && index < total);
    const completed = indices(raw?.completed);
    const failed = indices(raw?.failed).filter(index => !completed.includes(index));
    const pending = raw?.pendingUnit;
    const pendingUnit = pending && Number.isInteger(pending.downloadId) && pending.downloadId >= 0
        ? { downloadId: pending.downloadId, indices: indices(pending.indices),
            partNumber: normalizeNonNegativeInteger(pending.partNumber, 0) } : null;
    return { completed, failed, pendingUnit, nextPart: normalizePositiveInteger(raw?.nextPart, 1) };
}
async function recoverTasksUnlocked() {
    const store = await getTaskStore();
    const active = store.tasks.find(task => ACTIVE_JOB_STATUSES.has(task.status));
    if (!active) return store;
    const executor = await hasOffscreenDocument() ? await getOffscreenExecutorState() : null;
    if (executor?.activeJobId === active.jobId) return store;
    active.status = 'error';
    Object.assign(active, PixivMessages.make('job.interrupted'));
    active.updatedAt = Date.now();
    await saveTaskStore(store);
    return store;
}
async function startDownloadJobUnlocked(rawJob) {
    const store = await recoverTasksUnlocked();
    if (store.tasks.some(task => ACTIVE_JOB_STATUSES.has(task.status))) {
        throw PixivMessages.error('error.busy');
    }
    const job = normalizeJob(rawJob);
    while (store.tasks.length >= 50) {
        const oldest = store.tasks.filter(task => task.status === 'completed' && !task.failed)
            .sort((a, b) => (a.updatedAt || a.startedAt || 0) - (b.updatedAt || b.startedAt || 0))[0];
        if (!oldest) throw PixivMessages.error('error.historyFull');
        store.tasks = store.tasks.filter(task => task.jobId !== oldest.jobId);
    }
    const now = Date.now();
    const task = { jobId: job.jobId, type: job.type, title: String(rawJob.title || '').slice(0, 120),
        artworkId: String(rawJob.artworkId || '').slice(0, 32), status: 'starting',
        processed: 0, total: job.images.length, parts: 0, failed: 0, sequence: 0,
        startedAt: now, updatedAt: now, job, checkpoint: emptyCheckpoint() };
    store.tasks.unshift(task);
    return activateTaskUnlocked(store, task, false);
}
async function resumeJobUnlocked(jobId, retry) {
    const store = await recoverTasksUnlocked();
    if (store.tasks.some(task => ACTIVE_JOB_STATUSES.has(task.status))) {
        throw PixivMessages.error('error.busy');
    }
    const task = findTask(store, jobId);
    if (!task.job || (retry ? !publicState(task).canRetry : task.status !== 'paused')) {
        throw PixivMessages.error('error.unsupported');
    }
    if (retry) {
        task.checkpoint.failed = [];
        task.failed = 0;
        task.processed = task.checkpoint.completed.length;
    }
    return activateTaskUnlocked(store, task, retry);
}
async function activateTaskUnlocked(store, task, retry) {
    task.status = 'starting';
    task.runId = crypto.randomUUID();
    task.sequence = 0;
    Object.assign(task, PixivMessages.make('job.starting'));
    task.updatedAt = Date.now();
    await saveTaskStore(store);
    try {
        await setupOffscreenDocument();
        const response = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'start-job',
            job: { ...task.job, runId: task.runId, checkpoint: task.checkpoint, retry } });
        if (!response?.accepted) throw PixivMessages.fromResponse(response, 'error.notAccepted');
        task.status = 'running';
        Object.assign(task, PixivMessages.make('job.running'));
        await saveTaskStore(store);
        return { jobId: task.jobId, state: publicState(task), ...publicStore(store) };
    } catch (error) {
        task.status = 'error';
        Object.assign(task, PixivMessages.describe(error, 'error.start'));
        await saveTaskStore(store);
        await closeOffscreenDocumentForJobUnlocked(task.jobId).catch(() => {});
        throw error;
    }
}
async function interruptJobUnlocked(jobId, intent) {
    const store = await getTaskStore();
    const task = jobId ? findTask(store, jobId) : currentState(store);
    if (task?.status === 'paused' && intent === 'cancel') {
        task.status = 'cancelled';
        Object.assign(task, PixivMessages.make('job.stopped'));
        await saveTaskStore(store);
        if (await hasOffscreenDocument()) {
            await chrome.runtime.sendMessage({ target: 'offscreen', action: 'cancel-paused-job', jobId: task.jobId });
        }
        return { state: publicState(task), ...publicStore(store) };
    }
    if (!task || !ACTIVE_JOB_STATUSES.has(task.status)) return { state: publicState(task), ...publicStore(store) };
    if (['pausing', 'cancelling'].includes(task.status)) return { state: publicState(task), ...publicStore(store) };
    task.status = intent === 'pause' ? 'pausing' : 'cancelling';
    Object.assign(task, PixivMessages.make(intent === 'pause' ? 'job.pausing' : 'job.stopping'));
    await saveTaskStore(store);
    if (!await hasOffscreenDocument()) {
        task.status = 'error';
        Object.assign(task, PixivMessages.make('job.exited'));
        await saveTaskStore(store);
    } else {
        // 先响应，再控制下载和写入终态，避免与本队列形成环形等待。
        await chrome.runtime.sendMessage({ target: 'offscreen', action: intent === 'pause' ? 'pause-job' : 'cancel-job',
            jobId: task.jobId });
    }
    return { state: publicState(task), ...publicStore(store) };
}
async function dismissJobUnlocked(jobId) {
    const store = await getTaskStore();
    const task = findTask(store, jobId);
    if (!TERMINAL_JOB_STATUSES.has(task.status)) throw PixivMessages.error('error.stopBeforeRemove');
    store.tasks = store.tasks.filter(item => item.jobId !== jobId);
    await saveTaskStore(store);
    return publicStore(store);
}
async function updateJobStateUnlocked(update) {
    const store = await getTaskStore();
    const task = store.tasks.find(item => item.jobId === update?.jobId);
    if (!task || TERMINAL_JOB_STATUSES.has(task.status) || task.status === 'paused'
        || (task.runId && update.runId !== task.runId)) return { ignored: true };
    const sequence = normalizeNonNegativeInteger(update.sequence, 0);
    if (sequence <= (task.sequence || 0)) return { ignored: true };
    let status = ['running', 'pausing', 'paused', 'cancelling', 'completed', 'cancelled', 'error']
        .includes(update.status) ? update.status : task.status;
    const preserveIntent = ['pausing', 'cancelling'].includes(task.status) && status === 'running';
    if (preserveIntent) status = task.status;
    task.status = status;
    if (!preserveIntent) {
        task.message = String(update.message || '').slice(0, 240);
        task.messageKey = typeof update.messageKey === 'string' ? update.messageKey.slice(0, 80) : null;
        task.messageParams = update.messageKey && update.messageParams && typeof update.messageParams === 'object' ? update.messageParams : {};
    }
    for (const field of ['processed', 'parts', 'failed']) {
        task[field] = normalizeNonNegativeInteger(update[field], task[field] || 0);
    }
    if (update.checkpoint && task.job) task.checkpoint = normalizeCheckpoint(update.checkpoint, task.total);
    task.sequence = sequence;
    task.updatedAt = Date.now();
    if (status === 'completed' && task.failed === 0) {
        task.job = null;
        task.checkpoint = null;
    }
    await saveTaskStore(store);
    return { state: publicState(task), terminal: TERMINAL_JOB_STATUSES.has(status), ...publicStore(store) };
}
async function reconcilePersistedState() {
    return withJobLock(async () => updateActionBadge(currentState(await recoverTasksUnlocked())));
}
async function updateActionBadge(state) {
    if (state && ACTIVE_JOB_STATUSES.has(state.status)) {
        await chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
        await chrome.action.setBadgeText({ text: String(Math.min(99, Math.floor(state.processed / state.total * 100) || 0)) });
    } else {
        await chrome.action.setBadgeText({ text: state?.status === 'error' ? '!' : '' });
        if (state?.status === 'error') await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
}
async function hasOffscreenDocument() {
    return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)] })).length > 0;
}
async function setupOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chrome.offscreen.createDocument({ url: OFFSCREEN_DOCUMENT_PATH,
            reasons: ['BLOBS'], justification: '后台下载、分卷打包及保留暂停下载所需的 Blob' })
            .finally(() => { creatingOffscreenDocument = null; });
    }
    await creatingOffscreenDocument;
}
async function getOffscreenExecutorState() {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', action: 'get-executor-state' });
    if (!response || !Number.isInteger(response.pendingDownloads)) throw PixivMessages.error('error.executorState');
    return response;
}
async function closeOffscreenDocumentForJobUnlocked() {
    const store = await getTaskStore();
    if (store.tasks.some(task => ACTIVE_JOB_STATUSES.has(task.status))) return { ignored: true };
    if (!await hasOffscreenDocument()) return {};
    const executor = await getOffscreenExecutorState();
    if (executor.activeJobId || executor.pendingDownloads > 0) return { ignored: true };
    await chrome.offscreen.closeDocument();
    return {};
}
function controlBrowserDownload(downloadId, operation) {
    if (!Number.isInteger(downloadId) || !['pause', 'resume'].includes(operation)) {
        throw PixivMessages.error('error.control');
    }
    return new Promise((resolve, reject) => chrome.downloads[operation](downloadId, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message)); else resolve({});
    }));
}
