const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('../lib/jszip.min.js');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for lifecycle transition');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

// 两个 VM 分别加载真实 Service Worker 和 Offscreen 源码，只替换 Chrome/网络边界。
function fixture(t, options = {}) {
    let worker, offscreen, offscreenListener, stored = options.state || null;
    const localData = options.tasks ? { pixiv_download_tasks: { revision: 1, tasks: structuredClone(options.tasks) } } : {};
    const sessionData = { pixiv_download_job_state: stored };
    let nextDownloadId = 0, nextBlobId = 0, closed = 0, created = 0;
    let releaseCreation, creationStarted = false, fetches = 0;
    let releaseFinalReport, finalReportPending = false;
    const creationGate = new Promise(resolve => { releaseCreation = resolve; });
    const finalReportGate = new Promise(resolve => { releaseFinalReport = resolve; });
    const timers = new Set(), downloads = new Map(), blobs = new Map(), snapshots = [];
    const noop = async () => {};
    const sender = page => ({ id: 'test', url: `chrome-extension://test/${page}` });
    const scheduled = (fn, milliseconds) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, Math.min(milliseconds, 2));
        timers.add(timer);
        return timer;
    };
    t.after(() => { for (const timer of timers) clearTimeout(timer); });

    async function send(message, page) {
        if (message.target === 'popup') return {};
        if (message.target === 'background') {
            if (options.deferFinalReport && message.action === 'job-status-update'
                && ['completed', 'cancelled', 'error'].includes(message.update.status)) {
                finalReportPending = true;
                await finalReportGate;
            }
            try { return { success: true, ...await worker.handleMessage(message, sender(page)) }; }
            catch (error) { return { success: false, error: error.message }; }
        }
        if (!offscreenListener) throw new Error('No offscreen receiver');
        return new Promise((resolve, reject) => {
            let responded = false;
            offscreenListener(message, sender(page), response => { responded = true; resolve(response); });
            if (!responded) reject(new Error('No message response'));
        });
    }
    function chromeFor(page) {
        return {
            runtime: {
                id: 'test', getURL: p => `chrome-extension://test/${p}`,
                onMessage: { addListener(fn) { if (page === 'offscreen.html') offscreenListener = fn; } },
                onStartup: { addListener() {} }, onInstalled: { addListener() {} },
                async getContexts() { return offscreen ? [{}] : []; },
                sendMessage: message => send(message, page)
            },
            storage: {
                local: {
                    async get(key) { return { [key]: structuredClone(localData[key]) }; },
                    async set(value) { Object.assign(localData, structuredClone(value)); }
                },
                session: {
                    async get(key) { return { [key]: structuredClone(sessionData[key]) }; },
                    async set(value) {
                        Object.assign(sessionData, structuredClone(value));
                        stored = sessionData.pixiv_download_job_state;
                        snapshots.push(stored);
                    }
                }
            },
            action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
            downloads: {
                download(args, callback) {
                    const id = ++nextDownloadId;
                    downloads.set(id, { id, state: options.autoComplete ? 'complete' : 'in_progress',
                        paused: !options.autoComplete, url: args.url, filename: args.filename,
                        blob: blobs.get(args.url) });
                    callback(id);
                },
                search({ id }, callback) { callback(downloads.has(id) ? [downloads.get(id)] : []); },
                pause(id, callback) { downloads.get(id).paused = true; callback(); },
                resume(id, callback) { downloads.get(id).paused = false; callback(); }
            },
            offscreen: {
                async createDocument() {
                    creationStarted = true;
                    if (options.deferCreation) await creationGate;
                    created++;
                    loadOffscreen();
                },
                async closeDocument() { closed++; offscreen = null; offscreenListener = null; }
            }
        };
    }
    class BlobURL extends URL {
        static createObjectURL(blob) {
            const url = `blob:chrome-extension://test/${++nextBlobId}`;
            blobs.set(url, blob);
            return url;
        }
        static revokeObjectURL(url) { blobs.delete(url); }
    }
    class FileReader {
        readAsArrayBuffer(blob) {
            blob.arrayBuffer().then(result => { this.result = result; this.onload({ target: this }); }, error => {
                this.error = error; this.onerror({ target: this });
            });
        }
    }
    function loadOffscreen() {
        offscreen = vm.createContext({
            chrome: chromeFor('offscreen.html'), URL: BlobURL, Blob, FileReader, ArrayBuffer, Uint8Array,
            AbortController, structuredClone, queueMicrotask, setTimeout: scheduled, setImmediate, console,
            async fetch(url, { signal }) {
                fetches++;
                if (options.failUrls?.has(url)) return { ok: false, status: 500 };
                if (options.holdFetch || options.holdUrls?.has(url)) {
                    return new Promise((resolve, reject) => {
                        if (signal.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
                        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
                    });
                }
                return { ok: true, headers: { get: () => 'image/png' },
                    async blob() { return new Blob([Buffer.alloc(options.imageBytes || 8, 1)], { type: 'image/png' }); }
                };
            }
        });
        vm.runInContext(read('lib/jszip.min.js'), offscreen);
        vm.runInContext(read('offscreen.js'), offscreen);
    }
    function loadWorker() {
        worker = vm.createContext({ chrome: chromeFor('background.js'), URL, console,
            crypto: require('node:crypto').webcrypto });
        worker.importScripts = name => vm.runInContext(read(name), worker);
        vm.runInContext(read('background.js'), worker);
    }
    loadWorker();
    return { get worker() { return worker; }, get state() { return stored; },
        get closed() { return closed; }, get created() { return created; }, get exists() { return !!offscreen; },
        get creationStarted() { return creationStarted; }, get fetches() { return fetches; },
        get finalReportPending() { return finalReportPending; },
        get tasks() { return localData.pixiv_download_tasks?.tasks || []; },
        downloads, blobs, snapshots, releaseCreation, releaseFinalReport, loadWorker, options,
        start: job => send({ target: 'background', action: 'start-download-job', job }, 'popup.html'),
        cancel: jobId => send({ target: 'background', action: 'cancel-download-job', jobId }, 'popup.html'),
        pause: jobId => send({ target: 'background', action: 'pause-download-job', jobId }, 'popup.html'),
        resume: jobId => send({ target: 'background', action: 'resume-download-job', jobId }, 'popup.html'),
        retry: jobId => send({ target: 'background', action: 'retry-download-job', jobId }, 'popup.html'),
        dismiss: jobId => send({ target: 'background', action: 'dismiss-download-job', jobId }, 'popup.html'),
        list: () => send({ target: 'background', action: 'list-download-jobs' }, 'popup.html'),
        restore: () => send({ target: 'background', action: 'get-download-job' }, 'popup.html') };
}

function job(type = 'direct', count = 2, extra = {}) {
    return { type, images: Array.from({ length: count }, (_, i) => ({ index: i + 1,
        url: `https://i.pximg.net/p${i + 1}.png`, filename: `p${i + 1}.png`, extension: 'png' })),
        archiveName: 'test', maxImagesPerPart: 2, ...extra };
}

test('at the history limit, a new task evicts the oldest successful completion only', async t => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ jobId: 'old-' + index,
        status: 'completed', failed: 0, updatedAt: 100 + index, startedAt: index }));
    tasks[0].status = 'paused';
    tasks[1].failed = 1;
    tasks[2].status = 'error';
    tasks[3].updatedAt = 1000; // 创建早但完成晚，不能优先清理。
    const f = fixture(t, { autoComplete: true, tasks });
    const started = await f.start(job('direct', 1));
    assert.equal(started.success, true);
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.tasks.length, 50);
    assert.equal(f.tasks.some(task => task.jobId === 'old-4'), false);
    for (const id of ['old-0', 'old-1', 'old-2', 'old-3']) assert.ok(f.tasks.some(task => task.jobId === id));
});

test('a full history without successful completions rejects a new task without deleting records', async t => {
    const tasks = Array.from({ length: 50 }, (_, index) => ({ jobId: 'paused-' + index, status: 'paused' }));
    const f = fixture(t, { tasks });
    assert.equal((await f.start(job())).success, false);
    assert.equal(f.tasks.length, 50);
    assert.equal(f.created, 0);
});

test('two simultaneous popup starts accept one job without closing its executor', async t => {
    const f = fixture(t, { holdFetch: true });
    const results = await Promise.all([f.start(job()), f.start(job())]);
    assert.equal(results.filter(result => result.success).length, 1);
    assert.equal(f.state.jobId, results.find(result => result.success).jobId);
    assert.equal(f.state.status, 'running');
    assert.equal(f.closed, 0);
    assert.equal(f.created, 1);
    await until(() => f.fetches === 1);
    await f.cancel(f.state.jobId);
    await until(() => f.state.status === 'cancelled' && !f.exists);
});

test('popup restoration waits for document creation rather than marking startup interrupted', async t => {
    const f = fixture(t, { deferCreation: true, holdFetch: true });
    const starting = f.start(job());
    await until(() => f.creationStarted);
    assert.equal(f.state.status, 'starting');
    let restored = false;
    const restoring = f.restore().then(result => { restored = true; return result; });
    await tick();
    assert.equal(restored, false);
    assert.equal(f.state.status, 'starting');
    f.releaseCreation();
    const [startResult, restoreResult] = await Promise.all([starting, restoring]);
    assert.equal(startResult.success, true);
    assert.equal(restoreResult.state.status, 'running');
    assert.equal(f.snapshots.some(state => state.status === 'error'), false);
    await until(() => f.fetches === 1);
    await f.cancel(startResult.jobId);
    await until(() => f.state.status === 'cancelled');
});

test('stale starting state after worker restart is recoverable and does not block a new job', async t => {
    const f = fixture(t, { state: { jobId: 'abandoned', status: 'starting' }, autoComplete: true });
    const restored = await f.restore();
    assert.equal(restored.state.status, 'error');
    assert.equal((await f.start(job('direct', 1))).success, true);
    await until(() => f.state.status === 'completed' && !f.exists);
});

test('worker restart preserves a running offscreen job', async t => {
    const f = fixture(t, { holdFetch: true });
    const started = await f.start(job());
    await until(() => f.fetches === 1);
    f.loadWorker();
    assert.equal((await f.restore()).state.jobId, started.jobId);
    assert.equal(f.state.status, 'running');
    await f.cancel(started.jobId);
    await until(() => f.state.status === 'cancelled');
});

test('paused direct download can be stopped; its Blob survives a subsequent job and stale cleanup', async t => {
    const f = fixture(t);
    const started = await f.start(job());
    await until(() => f.downloads.size === 1);
    const old = f.downloads.get(1);
    await f.cancel(started.jobId);
    await until(() => f.state.status === 'cancelled');
    assert.equal(f.fetches, 1);
    assert.equal(f.blobs.has(old.url), true);
    assert.equal(f.exists, true);
    const next = await f.start(job('direct', 1));
    assert.equal(next.success, true);
    await until(() => f.downloads.size === 2);
    assert.equal(f.created, 1);
    old.state = 'complete';
    await until(() => !f.blobs.has(old.url));
    await f.worker.closeOffscreenDocumentForJob(started.jobId);
    assert.equal(f.exists, true);
    assert.equal(f.state.jobId, next.jobId);
    f.downloads.get(2).state = 'complete';
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.blobs.size, 0);
    assert.equal(f.closed, 1);
});

test('paused ZIP can be stopped without losing the submitted archive', async t => {
    const f = fixture(t);
    const started = await f.start(job('zip', 3));
    await until(() => f.downloads.size === 1);
    const download = f.downloads.get(1);
    await f.cancel(started.jobId);
    await until(() => f.state.status === 'cancelled');
    assert.equal(f.state.parts, 1);
    assert.equal(f.fetches, 2);
    assert.equal(f.blobs.has(download.url), true);
    const zip = await JSZip.loadAsync(Buffer.from(await download.blob.arrayBuffer()));
    assert.equal(await zip.file('test/p1.png').async('nodebuffer').then(bytes => bytes.length), 8);
    assert.equal(zip.file('test/p3.png'), null);
    download.state = 'complete';
    await until(() => !f.exists);
    assert.equal(f.blobs.size, 0);
});

test('normal ZIP splitting writes valid archives and cleans up all Blob URLs', async t => {
    const f = fixture(t, { autoComplete: true });
    assert.equal((await f.start(job('zip', 3))).success, true);
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.downloads.size, 2);
    assert.equal(f.state.parts, 2);
    assert.equal(f.blobs.size, 0);
    assert.equal(f.downloads.get(1).filename, 'test_part001.zip');
    assert.equal(f.downloads.get(2).filename, 'test_part002.zip');
    for (const [id, download] of f.downloads) {
        const zip = await JSZip.loadAsync(Buffer.from(await download.blob.arrayBuffer()));
        const entries = Object.values(zip.files).filter(entry => !entry.dir);
        assert.equal(entries.length, id === 1 ? 2 : 1);
    }
});

test('interrupted downloads release resources and count the failure', async t => {
    const f = fixture(t);
    await f.start(job('direct', 1));
    await until(() => f.downloads.size === 1);
    Object.assign(f.downloads.get(1), { state: 'interrupted', error: 'USER_CANCELED' });
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.state.failed, 1);
    assert.equal(f.blobs.size, 0);
});

test('concurrent progress updates cannot overwrite terminal state or cancellation', async t => {
    const f = fixture(t, { state: { jobId: 'test-job', status: 'running', sequence: 0 } });
    await Promise.all([
        f.worker.updateJobState({ jobId: 'test-job', sequence: 4, status: 'cancelling' }),
        f.worker.updateJobState({ jobId: 'test-job', sequence: 3, status: 'running' }),
        f.worker.updateJobState({ jobId: 'test-job', sequence: 5, status: 'running' })
    ]);
    assert.equal(f.state.sequence, 5);
    assert.equal(f.state.status, 'cancelling');
    await Promise.all([
        f.worker.updateJobState({ jobId: 'test-job', sequence: 6, status: 'cancelled' }),
        f.worker.updateJobState({ jobId: 'test-job', sequence: 7, status: 'running' })
    ]);
    assert.equal(f.state.status, 'cancelled');
    assert.equal(f.state.sequence, 6);
});

test('restoration during final status delivery does not misdiagnose a completed executor', async t => {
    const f = fixture(t, { autoComplete: true, deferFinalReport: true });
    const started = await f.start(job('direct', 1));
    await until(() => f.finalReportPending);
    assert.equal((await f.restore()).state.status, 'running');
    assert.equal(f.state.jobId, started.jobId);
    f.releaseFinalReport();
    await until(() => f.state.status === 'completed' && !f.exists);
});

test('completed task history survives worker restart; dismissal only removes its record', async t => {
    const f = fixture(t, { autoComplete: true });
    const first = await f.start(job('direct', 1, { title: '第一项' }));
    await until(() => f.state.status === 'completed' && !f.exists);
    const second = await f.start(job('direct', 1, { title: '第二项' }));
    await until(() => f.state.status === 'completed' && !f.exists);
    f.loadWorker();
    const list = await f.list();
    assert.deepEqual(list.tasks.map(task => task.jobId), [second.jobId, first.jobId]);
    assert.equal(list.tasks[1].title, '第一项');
    assert.equal('job' in list.tasks[0], false);
    assert.equal(f.tasks[0].job, null);
    assert.equal((await f.dismiss(first.jobId)).success, true);
    assert.equal(f.tasks.length, 1);
    assert.equal(f.downloads.size, 2);
    assert.equal((await f.dismiss(second.jobId)).tasks.length, 0);
    assert.equal((await f.list()).tasks.length, 0); // 不重新迁移已移除的旧 session 状态。
});

test('retry downloads only failed images and keeps the same task record', async t => {
    const f = fixture(t, { autoComplete: true, failUrls: new Set(['https://i.pximg.net/p2.png']) });
    const started = await f.start(job('direct', 3));
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.state.failed, 1);
    assert.equal(f.downloads.size, 2);
    f.options.failUrls.clear();
    assert.equal((await f.retry(started.jobId)).success, true);
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.state.failed, 0);
    assert.equal(f.tasks.length, 1);
    assert.equal(f.downloads.size, 3);
    assert.deepEqual([...f.downloads.values()].map(item => item.filename).sort(), ['p1.png', 'p2.png', 'p3.png']);
});

test('pause during fetch saves checkpoints; resume skips saved images after another task', async t => {
    const held = new Set(['https://i.pximg.net/p2.png']);
    const f = fixture(t, { autoComplete: true, holdUrls: held });
    const started = await f.start(job('direct', 3));
    await until(() => f.fetches === 2);
    await f.pause(started.jobId);
    await until(() => f.tasks.find(task => task.jobId === started.jobId).status === 'paused' && !f.exists);
    assert.deepEqual(f.tasks[0].checkpoint.completed, [0]);
    const other = job('direct', 1, { title: '其他任务' });
    other.images[0].filename = 'other.png';
    await f.start(other);
    await until(() => !f.exists);
    held.clear();
    f.loadWorker();
    assert.equal((await f.resume(started.jobId)).success, true);
    await until(() => f.tasks.find(task => task.jobId === started.jobId).status === 'completed' && !f.exists);
    assert.equal(f.downloads.size, 4);
    assert.equal([...f.downloads.values()].filter(item => item.filename === 'p1.png').length, 1);
});

test('pause and resume reuse the actual pending Chrome download and preserve its Blob', async t => {
    const f = fixture(t);
    const started = await f.start(job('direct', 2));
    await until(() => f.downloads.size === 1);
    const download = f.downloads.get(1);
    download.paused = false;
    await f.pause(started.jobId);
    await until(() => f.state.status === 'paused');
    assert.equal(download.paused, true);
    assert.equal(f.blobs.has(download.url), true);
    assert.equal(f.state.checkpoint.pendingUnit.downloadId, 1);
    assert.equal((await f.resume(started.jobId)).success, true);
    await until(() => download.paused === false);
    assert.equal(f.downloads.size, 1);
    download.state = 'complete';
    await until(() => f.downloads.size === 2);
    f.downloads.get(2).state = 'complete';
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.downloads.size, 2);
    assert.equal(f.blobs.size, 0);
});

test('ZIP pause resumes an existing volume and keeps numbering without duplicate archives', async t => {
    const f = fixture(t);
    const started = await f.start(job('zip', 3));
    await until(() => f.downloads.size === 1);
    f.downloads.get(1).paused = false;
    await f.pause(started.jobId);
    await until(() => f.state.status === 'paused');
    await f.resume(started.jobId);
    await until(() => f.downloads.get(1).paused === false);
    f.downloads.get(1).state = 'complete';
    await until(() => f.downloads.size === 2);
    assert.equal(f.fetches, 3);
    f.downloads.get(2).state = 'complete';
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.deepEqual([...f.downloads.values()].map(item => item.filename), ['test_part001.zip', 'test_part002.zip']);
    let entries = 0;
    for (const item of f.downloads.values()) {
        const zip = await JSZip.loadAsync(Buffer.from(await item.blob.arrayBuffer()));
        entries += Object.values(zip.files).filter(file => !file.dir).length;
    }
    assert.equal(entries, 3);
});

test('ZIP retry skips saved volumes and reconstructs only unfinished images', async t => {
    const f = fixture(t, { autoComplete: true, failUrls: new Set(['https://i.pximg.net/p3.png']) });
    const started = await f.start(job('zip', 4));
    await until(() => f.state.status === 'error' && !f.exists);
    assert.equal(f.downloads.size, 1);
    assert.deepEqual(f.state.checkpoint.completed, [0, 1]);
    f.options.failUrls.clear();
    await f.retry(started.jobId);
    await until(() => f.state.status === 'completed' && !f.exists);
    assert.equal(f.downloads.size, 2);
    assert.deepEqual([...f.downloads.values()].map(item => item.filename), ['test_part001.zip', 'test_part002.zip']);
});

test('active tasks cannot be dismissed and stale updates from an earlier run cannot change resumed state', async t => {
    const f = fixture(t, { holdFetch: true });
    const started = await f.start(job());
    await until(() => f.fetches === 1);
    const oldRunId = f.state.runId;
    assert.equal((await f.dismiss(started.jobId)).success, false);
    await f.pause(started.jobId);
    await until(() => f.state.status === 'paused');
    await f.resume(started.jobId);
    const result = await f.worker.updateJobState({ jobId: started.jobId, runId: oldRunId,
        sequence: 1000, status: 'completed', processed: 2 });
    assert.equal(result.ignored, true);
    assert.equal(f.state.status, 'running');
    await f.cancel(started.jobId);
    await until(() => f.state.status === 'cancelled');
});
