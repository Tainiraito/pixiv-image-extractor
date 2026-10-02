// popup.js — Pixiv 图片提取 v1.4.0

document.addEventListener('DOMContentLoaded', () => {
    const header = document.getElementById('header');
    const titleEl = document.getElementById('artwork-title');
    const authorEl = document.getElementById('artwork-author');
    const countEl = document.getElementById('artwork-count');
    const loadingEl = document.getElementById('loading');
    const errorState = document.getElementById('error-state');
    const errorMsg = document.getElementById('error-msg');
    const retryBtn = document.getElementById('retry-btn');
    const grid = document.getElementById('image-grid');
    const selectionInfo = document.getElementById('selection-info');
    const selectedCount = document.getElementById('selected-count');
    const totalCount = document.getElementById('total-count');
    const toggleAllBtn = document.getElementById('toggle-all-btn');
    const settingsDialog = document.getElementById('settings-dialog');
    const settingsBtn = document.getElementById('settings-btn');
    const historyDialog = document.getElementById('history-dialog');
    const historyList = document.getElementById('history-list');
    const taskOverflow = document.getElementById('task-overflow');
    const galleryCollapse = document.getElementById('gallery-collapse');
    const filenameInput = document.getElementById('filename-input');
    const zipBatchSizeInput = document.getElementById('zip-batch-size');
    const zipBatchSizeHint = document.getElementById('zip-batch-size-hint');
    const zipBatchValue = document.getElementById('zip-batch-value');
    const btnGroup = document.getElementById('btn-group');
    const downloadBtn = document.getElementById('download-btn');
    const zipBtn = document.getElementById('zip-btn');
    const taskSection = document.getElementById('task-section');
    const taskList = document.getElementById('task-list');
    const taskCount = document.getElementById('task-count');
    const statusText = document.getElementById('status-text');

    const TEMPLATE_STORAGE_KEY = 'pixiv_filename_template';
    const ZIP_BATCH_SIZE_STORAGE_KEY = 'pixiv_zip_batch_size';
    const DEFAULT_TEMPLATE = 'pixiv_{id}_{author}_{title}_p{index}';
    const DEFAULT_ARCHIVE_TEMPLATE = 'pixiv_{id}_{author}_{title}';
    const {
        ZIP_IMAGES_PER_PART,
        ZIP_BYTES_PER_PART
    } = PIXIV_EXTRACTOR_CONFIG;
    const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'pausing', 'cancelling']);

    let allImages = [];
    let currentArtworkId = null;
    let currentTitle = '';
    let currentAuthor = '';
    let selectedIndices = new Set();
    let isBusy = false;
    let isSubmitting = false;
    let galleryExpanded = false;
    let taskStates = [];
    let taskRevision = -1;
    const taskCards = new Map();
    const historyCards = new Map();
    const pendingTaskActions = new Set();

    // ─── 初始化 ───
    filenameInput.value = localStorage.getItem(TEMPLATE_STORAGE_KEY) || '';
    zipBatchSizeInput.min = String(ZIP_IMAGES_PER_PART.MIN);
    zipBatchSizeInput.max = String(ZIP_IMAGES_PER_PART.MAX);
    zipBatchSizeInput.value = String(ZIP_IMAGES_PER_PART.DEFAULT);
    zipBatchSizeHint.textContent = `默认 ${ZIP_IMAGES_PER_PART.DEFAULT} 张，`+
        `同时按约 ${formatMegabytes(ZIP_BYTES_PER_PART.DEFAULT)}MB 自动切卷`;
    zipBatchSizeInput.value = normalizeZipBatchSize(
        localStorage.getItem(ZIP_BATCH_SIZE_STORAGE_KEY)
    );
    zipBatchValue.value = zipBatchSizeInput.value + ' 张';

    chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.id !== chrome.runtime.id
            || message?.target !== 'popup'
            || message.action !== 'download-jobs-status') {
            return;
        }
        applyTaskSnapshot(message);
    });

    retryBtn.addEventListener('click', doExtract);
    filenameInput.addEventListener('input', () => {
        localStorage.setItem(TEMPLATE_STORAGE_KEY, filenameInput.value);
    });
    zipBatchSizeInput.addEventListener('input', () => {
        const batchSize = getZipBatchSize();
        zipBatchSizeInput.value = batchSize;
        zipBatchValue.value = batchSize + ' 张';
        localStorage.setItem(ZIP_BATCH_SIZE_STORAGE_KEY, String(batchSize));
        updateSelectionUI();
    });
    taskList.addEventListener('click', handleTaskAction);
    historyList.addEventListener('click', handleTaskAction);
    document.getElementById('history-btn').addEventListener('click', () => historyDialog.showModal());
    taskOverflow.addEventListener('click', () => historyDialog.showModal());
    document.getElementById('history-close').addEventListener('click', () => historyDialog.close());
    settingsBtn.addEventListener('click', () => settingsDialog.showModal());
    document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
    for (const dialog of [settingsDialog, historyDialog]) dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right
            || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    galleryCollapse.addEventListener('click', () => {
        galleryExpanded = false;
        renderGrid(allImages);
        updateSelectionUI();
        document.body.scrollTo(0, 0);
        grid.querySelector('.gallery-more')?.focus({ preventScroll: true });
    });

    doExtract();
    restoreBackgroundJob();

    // ─── 提取图片 ───
    async function doExtract() {
        header.style.display = 'none';
        grid.style.display = 'none';
        selectionInfo.style.display = 'none';
        galleryCollapse.hidden = true;
        btnGroup.style.display = 'none';
        errorState.style.display = 'none';
        loadingEl.style.display = '';
        setStatus('');
        syncTaskControls();

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!isPixivArtworkUrl(tab?.url)) {
                showError('请先打开 Pixiv 作品详情页');
                return;
            }

            let response;
            try {
                response = await chrome.tabs.sendMessage(tab.id, { action: 'extract-images' });
            } catch (error) {
                console.error('[Pixiv 提取] 无法连接内容脚本:', error);
                throw new Error('无法连接到作品页，请刷新 Pixiv 页面后重试');
            }

            if (!response?.success) {
                showError(response?.error || '提取失败');
                return;
            }
            if (!Array.isArray(response.images) || response.images.length === 0) {
                showError('Pixiv 未返回可下载的图片');
                return;
            }

            // 仅接受 Pixiv 图片域名，避免异常 API 数据触发跨站请求。
            allImages = response.images.map((image, index) => ({
                index: Number.isInteger(image.index) ? image.index : index + 1,
                previewUrl: validatePximgUrl(image.previewUrl),
                originalUrl: validatePximgUrl(image.originalUrl)
            }));

            currentArtworkId = String(response.artworkId || 'unknown');
            currentTitle = String(response.title || '未知作品');
            currentAuthor = String(response.author || '未知作者');
            selectedIndices.clear();
            galleryExpanded = false;

            titleEl.textContent = currentTitle;
            authorEl.textContent = currentAuthor;
            countEl.textContent = `${allImages.length} 张图片`;
            header.style.display = '';

            renderGrid(allImages);
            loadingEl.style.display = 'none';
            grid.style.display = '';
            selectionInfo.style.display = '';
            btnGroup.style.display = '';
            updateSelectionUI();
            syncTaskControls();
        } catch (error) {
            console.error('[Pixiv 提取] 异常:', error);
            showError(getErrorMessage(error, '提取过程中发生错误'));
        }
    }

    // ─── 任务列表与操作 ───
    async function restoreBackgroundJob() {
        try { applyTaskSnapshot(await sendBackgroundRequest('list-download-jobs')); }
        catch (error) { setStatus('无法读取任务列表：' + getErrorMessage(error, '未知错误'), 'error'); }
    }

    function applyTaskSnapshot(snapshot) {
        if (!Array.isArray(snapshot.tasks) || snapshot.revision < taskRevision) return;
        taskRevision = snapshot.revision;
        taskStates = snapshot.tasks;
        syncTaskControls();
        renderTasks();
    }

    function beginSubmittingJob() {
        if (isBusy) return false;
        isSubmitting = true;
        syncTaskControls();
        return true;
    }

    function resetSubmittingJob() {
        isSubmitting = false;
        syncTaskControls();
    }

    function syncTaskControls() {
        isBusy = isSubmitting || taskStates.some(state => ACTIVE_JOB_STATUSES.has(state.status));
        filenameInput.disabled = isBusy;
        zipBatchSizeInput.disabled = isBusy;
        updateSelectionUI();
    }

    async function submitBackgroundJob(job) {
        try {
            const response = await sendBackgroundRequest('start-download-job', {
                job: { ...job, title: currentTitle, artworkId: currentArtworkId }
            });
            applyTaskSnapshot(response);
            setStatus('');
        } finally {
            resetSubmittingJob();
            renderTasks();
        }
    }

    function sendBackgroundRequest(action, payload = {}) {
        return chrome.runtime.sendMessage({ target: 'background', action, ...payload }).then(response => {
            if (!response?.success) throw new Error(response?.error || '后台服务无响应');
            return response;
        });
    }

    function createTaskCard(state) {
        const card = document.createElement('article');
        card.className = 'task-card';
        card.dataset.jobId = state.jobId;
        const head = document.createElement('div');
        head.className = 'task-head';
        const title = document.createElement('div');
        title.className = 'task-title';
        const badge = document.createElement('span');
        badge.className = 'task-badge';
        const dismiss = makeTaskButton('dismiss-download-job', '×', 'task-dismiss');
        dismiss.title = '移除记录，不删除已下载的文件';
        head.append(title, badge, dismiss);

        const progress = document.createElement('progress');
        progress.className = 'task-progress';
        const summary = document.createElement('div');
        summary.className = 'task-summary';
        const actions = document.createElement('div');
        actions.className = 'task-actions';
        const pause = makeTaskButton('pause-download-job', '暂停');
        const resume = makeTaskButton('resume-download-job', '继续');
        const retry = makeTaskButton('retry-download-job', '重试');
        const stop = makeTaskButton('cancel-download-job', '停止');
        actions.append(pause, resume, retry, stop);
        const detail = document.createElement('div');
        detail.className = 'task-detail';
        detail.append(summary, actions);
        card.append(head, detail, progress);
        return { card, title, badge, dismiss, progress, summary, pause, resume, retry, stop };
    }

    function makeTaskButton(action, label, className = 'task-action') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.dataset.taskAction = action;
        button.textContent = label;
        return button;
    }

    function renderTasks() {
        const unfinished = taskStates.filter(state => state.status !== 'completed' || state.failed > 0)
            .sort((a, b) => Number(ACTIVE_JOB_STATUSES.has(b.status)) - Number(ACTIVE_JOB_STATUSES.has(a.status))
                || (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0));
        taskSection.hidden = unfinished.length === 0;
        taskCount.textContent = String(unfinished.length);
        taskOverflow.hidden = unfinished.length <= 3;
        document.getElementById('history-count').textContent = String(taskStates.length);
        document.getElementById('history-empty').hidden = taskStates.length > 0;
        renderTaskList(unfinished.slice(0, 3), taskList, taskCards);
        renderTaskList(taskStates, historyList, historyCards);
    }

    function renderTaskList(states, list, cards) {
        const ids = new Set(states.map(state => state.jobId));
        for (const [id, nodes] of cards) {
            if (!ids.has(id)) { nodes.card.remove(); cards.delete(id); }
        }
        const labels = { starting: '启动中', running: '进行中', pausing: '正在暂停',
            paused: '已暂停', cancelling: '正在停止', cancelled: '已停止', completed: '已完成', error: '失败' };
        states.forEach((state, index) => {
            let nodes = cards.get(state.jobId);
            if (!nodes) { nodes = createTaskCard(state); cards.set(state.jobId, nodes); }
            const { card, title, badge, dismiss, progress, summary, pause, resume, retry, stop } = nodes;
            if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
            const failed = state.failed || 0;
            const processed = state.processed || 0;
            const total = state.total || 0;
            const active = ACTIVE_JOB_STATUSES.has(state.status);
            const transitioning = ['starting', 'pausing', 'cancelling'].includes(state.status);
            const pending = pendingTaskActions.has(state.jobId);
            const hasFailures = state.status === 'error' || failed > 0;
            card.dataset.status = hasFailures ? 'error' : state.status;
            title.textContent = state.title || 'Pixiv 图片';
            title.title = title.textContent;
            badge.textContent = state.status === 'completed' && failed > 0 ? '部分失败' : labels[state.status] || state.status;
            progress.max = Math.max(1, total);
            progress.value = Math.min(total, processed);
            progress.setAttribute('aria-label', title.textContent + '，已处理 ' + processed + '/' + total);
            summary.textContent = (state.type === 'zip' ? 'ZIP ' : '图片 ') + Math.max(0, processed - failed) + '/' + total
                + (state.type === 'zip' ? ' · ' + (state.parts || 0) + ' 卷' : '')
                + (failed ? ' · ' + failed + ' 张失败' : '');
            summary.title = [state.artworkId ? '#' + state.artworkId : '', state.message].filter(Boolean).join(' · ');
            card.setAttribute('aria-label', title.textContent + '，' + badge.textContent + '，' + summary.textContent);
            dismiss.hidden = !['completed', 'error', 'cancelled'].includes(state.status);
            dismiss.disabled = pending;
            dismiss.setAttribute('aria-label', '移除任务：' + title.textContent);
            pause.hidden = !active;
            pause.disabled = transitioning || pending;
            resume.hidden = !state.canResume;
            resume.disabled = isBusy || pending;
            retry.hidden = !state.canRetry;
            retry.disabled = isBusy || pending;
            for (const button of [resume, retry]) button.title = isBusy ? '请先暂停或停止正在执行的任务' : '';
            stop.hidden = !active && state.status !== 'paused';
            stop.disabled = transitioning || pending;
        });
    }

    async function handleTaskAction(event) {
        const button = event.target.closest('button[data-task-action]');
        if (!button || button.disabled) return;
        const jobId = button.closest('.task-card').dataset.jobId;
        if (pendingTaskActions.has(jobId)) return;
        pendingTaskActions.add(jobId);
        renderTasks();
        setStatus('');
        try {
            applyTaskSnapshot(await sendBackgroundRequest(button.dataset.taskAction, { jobId }));
        } catch (error) {
            setStatus(getErrorMessage(error, '任务操作失败'), 'error');
        } finally {
            pendingTaskActions.delete(jobId);
            renderTasks();
        }
    }

    // ─── 渲染与选择 ───
    function renderGrid(images) {
        grid.replaceChildren();
        const collapsed = images.length > 9 && !galleryExpanded;
        galleryCollapse.hidden = images.length <= 9 || !galleryExpanded;
        const visibleImages = collapsed ? images.slice(0, 8) : images;

        visibleImages.forEach((image, index) => {
            const card = document.createElement('div');
            card.className = 'image-card';
            card.dataset.imageIndex = String(index);
            card.tabIndex = 0;
            card.setAttribute('role', 'checkbox');
            card.setAttribute('aria-label', `选择图片 ${image.index}`);
            card.setAttribute('aria-checked', 'false');

            const preview = document.createElement('img');
            preview.src = image.previewUrl;
            preview.alt = `图片 ${image.index}`;
            preview.loading = 'lazy';
            preview.draggable = false;

            const checkbox = document.createElement('div');
            checkbox.className = 'checkbox';
            checkbox.textContent = '✓';

            const pageLabel = document.createElement('div');
            pageLabel.className = 'page-label';
            pageLabel.textContent = `${image.index}/${images.length}`;

            card.append(preview, checkbox, pageLabel);
            card.addEventListener('click', () => toggleSelect(index));
            card.addEventListener('keydown', event => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                toggleSelect(index);
            });
            grid.appendChild(card);
        });
        if (collapsed) {
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'gallery-more';
            more.setAttribute('aria-label', '查看全部 ' + images.length + ' 张图片');
            more.setAttribute('aria-expanded', 'false');
            const mosaic = document.createElement('span');
            mosaic.className = 'gallery-mosaic';
            mosaic.setAttribute('aria-hidden', 'true');
            for (let index = 0; index < 9; index++) {
                const preview = document.createElement('img');
                preview.src = images[8 + index % (images.length - 8)].previewUrl;
                preview.alt = '';
                preview.draggable = false;
                mosaic.appendChild(preview);
            }
            const label = document.createElement('span');
            label.className = 'gallery-more-label';
            label.textContent = '查看全部' + images.length + '张';
            more.append(mosaic, label);
            more.addEventListener('click', () => {
                galleryExpanded = true;
                renderGrid(allImages);
                updateSelectionUI();
                grid.querySelector('[data-image-index="8"]')?.focus({ preventScroll: true });
            });
            grid.appendChild(more);
        }
    }

    function toggleSelect(index) {
        if (isBusy) return;

        selectedIndices.has(index) ? selectedIndices.delete(index) : selectedIndices.add(index);
        updateSelectionUI();
    }

    function updateSelectionUI() {
        grid.querySelectorAll('.image-card').forEach(card => {
            const isSelected = selectedIndices.has(Number(card.dataset.imageIndex));
            card.classList.toggle('selected', isSelected);
            card.setAttribute('aria-checked', String(isSelected));
        });

        const count = selectedIndices.size;
        const total = allImages.length;
        const estimatedParts = Math.max(1, Math.ceil(count / getZipBatchSize()));

        selectedCount.textContent = count;
        totalCount.textContent = total;
        toggleAllBtn.textContent = count === total && total > 0 ? '取消全选' : '全选';
        toggleAllBtn.disabled = isBusy;

        downloadBtn.disabled = isBusy || count === 0;
        downloadBtn.textContent = count > 1 ? `逐张下载 (${count})` : '下载';

        zipBtn.disabled = isBusy || count === 0;
        zipBtn.textContent = count > getZipBatchSize()
            ? `分卷下载 (约 ${estimatedParts} 卷)`
            : '打包下载';
    }

    toggleAllBtn.addEventListener('click', () => {
        if (isBusy) return;

        if (selectedIndices.size === allImages.length) {
            selectedIndices.clear();
        } else {
            allImages.forEach((_, index) => selectedIndices.add(index));
        }
        updateSelectionUI();
    });

    // ─── 创建后台下载任务 ───
    downloadBtn.addEventListener('click', async () => {
        if (selectedIndices.size === 0 || !beginSubmittingJob()) return;

        try {
            const template = filenameInput.value;
            const images = getSelectedImages().map(image => {
                const extension = getExtFromUrl(image.originalUrl);
                return {
                    index: image.index,
                    url: image.originalUrl,
                    filename: buildFilename(template, {
                        id: currentArtworkId,
                        author: currentAuthor,
                        title: currentTitle,
                        index: image.index
                    }) + `.${extension}`
                };
            });

            setStatus('正在创建下载任务...', 'info');
            await submitBackgroundJob({ type: 'direct', images });
        } catch (error) {
            resetSubmittingJob();
            console.error('[后台下载] 启动失败:', error);
            setStatus(`下载启动失败：${getErrorMessage(error, '未知错误')}`, 'error');
        }
    });

    zipBtn.addEventListener('click', async () => {
        if (selectedIndices.size === 0 || !beginSubmittingJob()) return;

        try {
            const images = getSelectedImages().map(image => ({
                index: image.index,
                url: image.originalUrl,
                extension: getExtFromUrl(image.originalUrl)
            }));

            setStatus('正在创建打包任务...', 'info');
            await submitBackgroundJob({
                type: 'zip',
                images,
                archiveName: buildArchiveName(filenameInput.value),
                maxImagesPerPart: getZipBatchSize(),
                maxBytesPerPart: ZIP_BYTES_PER_PART.DEFAULT
            });
        } catch (error) {
            resetSubmittingJob();
            console.error('[后台打包] 启动失败:', error);
            setStatus(`打包启动失败：${getErrorMessage(error, '未知错误')}`, 'error');
        }
    });

    // ─── 文件名与 URL 校验 ───
    function buildFilename(template, variables, fallbackTemplate = DEFAULT_TEMPLATE) {
        const source = template && template.trim() ? template.trim() : fallbackTemplate;
        const filename = source
            .replace(/{id}/g, variables.id || 'unknown')
            .replace(/{author}/g, variables.author || 'unknown')
            .replace(/{title}/g, variables.title || 'unknown')
            .replace(/{index}/g, variables.index || '0')
            .replace(/[\u0000-\u001f\u007f]/g, '_')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .replace(/[. ]+$/g, '')
            .slice(0, 180)
            .trim();

        return filename || 'pixiv_image';
    }

    function buildArchiveName(template) {
        const resolvedTemplate = template && template.trim() ? template.trim() : DEFAULT_TEMPLATE;
        const archiveTemplate = resolvedTemplate
            .replace(/_p\{index\}$/i, '')
            .replace(/\{index\}/gi, '');

        return buildFilename(archiveTemplate, {
            id: currentArtworkId,
            author: currentAuthor,
            title: currentTitle,
            index: ''
        }, DEFAULT_ARCHIVE_TEMPLATE);
    }

    function getExtFromUrl(url) {
        const pathname = new URL(url).pathname;
        return pathname.match(/\.(jpg|jpeg|png|gif|webp)$/i)?.[1].toLowerCase() || 'jpg';
    }

    function validatePximgUrl(url) {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error('Pixiv 返回了无效的图片地址');
        }

        if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.pximg.net') {
            throw new Error(`拒绝访问非 Pixiv 图片地址：${parsed.hostname || '未知域名'}`);
        }
        return parsed.href;
    }

    function isPixivArtworkUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'https:'
                && parsed.hostname === 'www.pixiv.net'
                && /^\/artworks\/\d+\/?$/.test(parsed.pathname);
        } catch {
            return false;
        }
    }

    function getSelectedImages() {
        return [...selectedIndices]
            .sort((left, right) => left - right)
            .map(index => allImages[index]);
    }

    function getZipBatchSize() {
        return normalizeZipBatchSize(zipBatchSizeInput.value);
    }

    function normalizeZipBatchSize(value) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) return ZIP_IMAGES_PER_PART.DEFAULT;
        return Math.min(
            ZIP_IMAGES_PER_PART.MAX,
            Math.max(ZIP_IMAGES_PER_PART.MIN, parsed)
        );
    }

    function formatMegabytes(bytes) {
        return Math.round(bytes / (1024 * 1024));
    }

    function getErrorMessage(error, fallback) {
        const message = typeof error?.message === 'string' ? error.message.trim() : '';
        return message ? message.slice(0, 180) : fallback;
    }

    // ─── 通用 UI ───
    function showError(message) {
        loadingEl.style.display = 'none';
        errorState.style.display = '';
        errorMsg.textContent = message;
    }

    function setStatus(text, type) {
        statusText.textContent = text;
        statusText.hidden = !text;
        statusText.className = `status-text status-${type}`;
    }
});
