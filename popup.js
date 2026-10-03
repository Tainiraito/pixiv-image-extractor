// popup.js — Pixiv 图片提取 v1.5.0

document.addEventListener('DOMContentLoaded', async () => {
    const { t } = PixivI18n;
    await PixivI18n.init();
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

    const autoCloseInput = document.getElementById('auto-close-popup');
    const AUTO_CLOSE_STORAGE_KEY = 'pixiv_auto_close_popup';
    const shouldAutoClose = () => localStorage.getItem(AUTO_CLOSE_STORAGE_KEY) !== 'false';
    autoCloseInput.checked = shouldAutoClose();
    autoCloseInput.addEventListener('change', () => {
        localStorage.setItem(AUTO_CLOSE_STORAGE_KEY, String(autoCloseInput.checked));
    });
    window.addEventListener('storage', event => {
        if (event.key === AUTO_CLOSE_STORAGE_KEY || event.key === null) autoCloseInput.checked = shouldAutoClose();
    });

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

    let statusMessage = '', errorMessage = '';
    const languageSelect = document.getElementById('language-select');
    for (const locale of PixivI18n.registry) {
        const option = document.createElement('option');
        option.value = locale.code; option.textContent = locale.nativeName;
        languageSelect.append(option);
    }
    languageSelect.addEventListener('change', () => PixivI18n.select(languageSelect.value)
        .catch(error => { languageSelect.value = PixivI18n.language; setStatus(PixivMessages.describe(error), 'error'); }));
    PixivI18n.onChange(refreshLanguage);
    // ─── 初始化 ───
    filenameInput.value = localStorage.getItem(TEMPLATE_STORAGE_KEY) || '';
    zipBatchSizeInput.min = String(ZIP_IMAGES_PER_PART.MIN);
    zipBatchSizeInput.max = String(ZIP_IMAGES_PER_PART.MAX);
    zipBatchSizeInput.value = String(ZIP_IMAGES_PER_PART.DEFAULT);
    zipBatchSizeHint.textContent = t('settings.zipHint', { count: ZIP_IMAGES_PER_PART.DEFAULT, size: formatMegabytes(ZIP_BYTES_PER_PART.DEFAULT) });
    zipBatchSizeInput.value = normalizeZipBatchSize(
        localStorage.getItem(ZIP_BATCH_SIZE_STORAGE_KEY)
    );
    zipBatchValue.value = t('images.unit', { count: Number(zipBatchSizeInput.value) });

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
        zipBatchValue.value = t('images.unit', { count: batchSize });
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

    refreshLanguage();
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
                showError(PixivMessages.make('error.openArtwork'));
                return;
            }

            let response;
            try {
                response = await chrome.tabs.sendMessage(tab.id, { action: 'extract-images' });
            } catch (error) {
                console.error('[Pixiv 提取] 无法连接内容脚本:', error);
                throw PixivMessages.error('error.connectPage');
            }

            if (!response?.success) {
                showError(PixivMessages.describe(PixivMessages.fromResponse(response, 'error.extract')));
                return;
            }
            if (!Array.isArray(response.images) || response.images.length === 0) {
                showError(PixivMessages.make('error.noImages'));
                return;
            }

            // 仅接受 Pixiv 图片域名，避免异常 API 数据触发跨站请求。
            allImages = response.images.map((image, index) => ({
                index: Number.isInteger(image.index) ? image.index : index + 1,
                previewUrl: validatePximgUrl(image.previewUrl),
                originalUrl: validatePximgUrl(image.originalUrl)
            }));

            currentArtworkId = String(response.artworkId || 'unknown');
            currentTitle = String(response.title || '');
            currentAuthor = String(response.author || '');
            selectedIndices.clear();
            galleryExpanded = false;

            titleEl.textContent = currentTitle || t('artwork.unknown');
            authorEl.textContent = currentAuthor || t('author.unknown');
            countEl.textContent = t('images.count', { count: allImages.length });
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
            showError(PixivMessages.describe(error, 'error.extractUnexpected'));
        }
    }

    // ─── 任务列表与操作 ───
    async function restoreBackgroundJob() {
        try { applyTaskSnapshot(await sendBackgroundRequest('list-download-jobs')); }
        catch (error) { setStatus(PixivMessages.make('error.history', { detail: errorDescriptor(error) }), 'error'); }
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
            // Only close after the executor has accepted the task; failures stay visible.
            if (shouldAutoClose()) window.close();
        } finally {
            resetSubmittingJob();
            renderTasks();
        }
    }

    function sendBackgroundRequest(action, payload = {}) {
        return chrome.runtime.sendMessage({ target: 'background', action, ...payload }).then(response => {
            if (!response?.success) throw PixivMessages.fromResponse(response);
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
        dismiss.title = t('task.dismissHint');
        head.append(title, badge, dismiss);

        const progress = document.createElement('progress');
        progress.className = 'task-progress';
        const summary = document.createElement('div');
        summary.className = 'task-summary';
        const actions = document.createElement('div');
        actions.className = 'task-actions';
        const pause = makeTaskButton('pause-download-job', t('action.pause'));
        const resume = makeTaskButton('resume-download-job', t('action.resume'));
        const retry = makeTaskButton('retry-download-job', t('action.retry'));
        const stop = makeTaskButton('cancel-download-job', t('action.stop'));
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
        document.getElementById('task-overflow-label').textContent = t('task.count', { count: unfinished.length });
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
        const labels = Object.fromEntries(['starting', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'error'].map(key => [key, t('status.' + key)]));
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
            title.textContent = state.title || t(state.titleKey || 'task.defaultTitle');
            title.title = title.textContent;
            badge.textContent = state.status === 'completed' && failed > 0 ? t('status.partial') : labels[state.status] || state.status;
            progress.max = Math.max(1, total);
            progress.value = Math.min(total, processed);
            progress.setAttribute('aria-label', t('task.progress', { title: title.textContent, processed, total }));
            summary.textContent = t(state.type === 'zip' ? 'task.zip' : 'task.images', { saved: Math.max(0, processed - failed), total })
                + (state.type === 'zip' ? t('task.parts', { count: state.parts || 0 }) : '')
                + (failed ? t('task.failed', { count: failed }) : '');
            summary.title = [state.artworkId ? '#' + state.artworkId : '', taskMessage(state)].filter(Boolean).join(' · ');
            card.setAttribute('aria-label', [title.textContent, badge.textContent, summary.textContent].join(' · '));
            dismiss.hidden = !['completed', 'error', 'cancelled'].includes(state.status);
            dismiss.disabled = pending;
            dismiss.setAttribute('aria-label', t('task.dismiss', { title: title.textContent }));
            dismiss.title = t('task.dismissHint');
            for (const [button, key] of [[pause,'pause'],[resume,'resume'],[retry,'retry'],[stop,'stop']]) button.textContent = t('action.' + key);
            pause.hidden = !active;
            pause.disabled = transitioning || pending;
            resume.hidden = !state.canResume;
            resume.disabled = isBusy || pending;
            retry.hidden = !state.canRetry;
            retry.disabled = isBusy || pending;
            for (const button of [resume, retry]) button.title = isBusy ? t('task.busy') : '';
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
            setStatus(PixivMessages.describe(error, 'error.taskAction'), 'error');
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
            card.setAttribute('aria-label', t('gallery.select', { index: image.index }));
            card.setAttribute('aria-checked', 'false');

            const preview = document.createElement('img');
            preview.src = image.previewUrl;
            preview.alt = t('gallery.image', { index: image.index });
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
            more.setAttribute('aria-label', t('gallery.allLabel', { count: images.length }));
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
            label.textContent = t('gallery.all', { count: images.length });
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
        toggleAllBtn.textContent = count === total && total > 0 ? t('selection.none') : t('selection.all');
        toggleAllBtn.disabled = isBusy;

        downloadBtn.disabled = isBusy || count === 0;
        downloadBtn.textContent = count > 1 ? t('download.multiple', { count }) : t('download.single');

        zipBtn.disabled = isBusy || count === 0;
        zipBtn.textContent = count > getZipBatchSize()
            ? t('download.parts', { count: estimatedParts })
            : t('download.zip');
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

            setStatus(PixivMessages.make('notice.createDirect'), 'info');
            await submitBackgroundJob({ type: 'direct', images });
        } catch (error) {
            resetSubmittingJob();
            console.error('[后台下载] 启动失败:', error);
            setStatus(PixivMessages.make('error.startDirect', { detail: errorDescriptor(error) }), 'error');
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

            setStatus(PixivMessages.make('notice.createZip'), 'info');
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
            setStatus(PixivMessages.make('error.startZip', { detail: errorDescriptor(error) }), 'error');
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
            throw PixivMessages.error('error.invalidImage');
        }

        if (parsed.protocol !== 'https:' || parsed.hostname !== 'i.pximg.net') {
            throw PixivMessages.error('error.imageHost', { host: parsed.hostname });
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

    function errorDescriptor(error) { return PixivMessages.describe(error); }
    function displayMessage(message) {
        if (!message?.messageKey) return String(message || '');
        const params = Object.fromEntries(Object.entries(message.messageParams || {}).map(([key, value]) =>
            [key, value?.messageKey ? displayMessage(value) : value]));
        return t(message.messageKey, params);
    }
    function taskMessage(state) {
        if (state.messageKey) return displayMessage(state);
        // Old tasks use structured status/counts; preserve unknown external error details.
        if (state.status === 'completed') return t(state.failed ? 'job.partial' : state.type === 'zip' ? 'job.zipComplete' : 'job.complete',
            { count: Math.max(0, state.processed - (state.failed || 0)), total: state.total, failed: state.failed, parts: state.parts });
        const key = { starting: 'job.starting', running: 'job.running', pausing: 'job.pausing', paused: 'job.paused',
            cancelling: 'job.stopping', cancelled: 'job.stopped' }[state.status];
        return key ? t(key) : state.message || t('status.error');
    }
    function refreshLanguage() {
        PixivI18n.render();
        languageSelect.value = PixivI18n.language;
        titleEl.textContent = currentTitle || t('artwork.unknown');
        authorEl.textContent = currentAuthor || t('author.unknown');
        countEl.textContent = t('images.count', { count: allImages.length });
        zipBatchSizeHint.textContent = t('settings.zipHint', { count: ZIP_IMAGES_PER_PART.DEFAULT, size: formatMegabytes(ZIP_BYTES_PER_PART.DEFAULT) });
        zipBatchValue.value = t('images.unit', { count: getZipBatchSize() });
        for (const card of grid.querySelectorAll('.image-card')) {
            const image = allImages[Number(card.dataset.imageIndex)];
            card.setAttribute('aria-label', t('gallery.select', { index: image.index }));
            card.querySelector('img').alt = t('gallery.image', { index: image.index });
        }
        const more = grid.querySelector('.gallery-more');
        if (more) {
            more.setAttribute('aria-label', t('gallery.allLabel', { count: allImages.length }));
            more.querySelector('.gallery-more-label').textContent = t('gallery.all', { count: allImages.length });
        }
        updateSelectionUI(); renderTasks();
        errorMsg.textContent = displayMessage(errorMessage);
        statusText.textContent = displayMessage(statusMessage);
    }
    function showError(message) {
        errorMessage = message;
        loadingEl.style.display = 'none';
        errorState.style.display = '';
        errorMsg.textContent = displayMessage(message);
    }
    function setStatus(message, type) {
        statusMessage = message;
        statusText.textContent = displayMessage(message);
        statusText.hidden = !message;
        statusText.className = 'status-text status-' + type;
    }
});
