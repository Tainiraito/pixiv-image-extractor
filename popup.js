// popup.js — Pixiv 图片提取 v1.3.0

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
    const filenameSection = document.getElementById('filename-section');
    const filenameInput = document.getElementById('filename-input');
    const zipBatchSizeInput = document.getElementById('zip-batch-size');
    const zipBatchSizeHint = document.getElementById('zip-batch-size-hint');
    const btnGroup = document.getElementById('btn-group');
    const downloadBtn = document.getElementById('download-btn');
    const zipBtn = document.getElementById('zip-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const statusText = document.getElementById('status-text');

    const TEMPLATE_STORAGE_KEY = 'pixiv_filename_template';
    const ZIP_BATCH_SIZE_STORAGE_KEY = 'pixiv_zip_batch_size';
    const DEFAULT_TEMPLATE = 'pixiv_{id}_{author}_{title}_p{index}';
    const DEFAULT_ARCHIVE_TEMPLATE = 'pixiv_{id}_{author}_{title}';
    const {
        ZIP_IMAGES_PER_PART,
        ZIP_BYTES_PER_PART
    } = PIXIV_EXTRACTOR_CONFIG;
    const ACTIVE_JOB_STATUSES = new Set(['starting', 'running', 'cancelling']);

    let allImages = [];
    let currentArtworkId = null;
    let currentTitle = '';
    let currentAuthor = '';
    let selectedIndices = new Set();
    let isBusy = false;
    let currentJobId = null;
    let currentJobStatus = null;

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

    chrome.runtime.onMessage.addListener((message, sender) => {
        if (sender.id !== chrome.runtime.id
            || message?.target !== 'popup'
            || message.action !== 'download-job-status') {
            return;
        }
        applyBackgroundJobState(message.state);
    });

    retryBtn.addEventListener('click', doExtract);
    filenameInput.addEventListener('input', () => {
        localStorage.setItem(TEMPLATE_STORAGE_KEY, filenameInput.value);
    });
    zipBatchSizeInput.addEventListener('change', () => {
        const batchSize = getZipBatchSize();
        zipBatchSizeInput.value = batchSize;
        localStorage.setItem(ZIP_BATCH_SIZE_STORAGE_KEY, String(batchSize));
        updateSelectionUI();
    });
    cancelBtn.addEventListener('click', cancelBackgroundJob);

    doExtract();
    restoreBackgroundJob();

    // ─── 提取图片 ───
    async function doExtract() {
        header.style.display = 'none';
        grid.style.display = 'none';
        selectionInfo.style.display = 'none';
        filenameSection.style.display = 'none';
        btnGroup.style.display = 'none';
        errorState.style.display = 'none';
        loadingEl.style.display = '';
        statusText.textContent = '';
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

            titleEl.textContent = currentTitle;
            authorEl.textContent = currentAuthor;
            countEl.textContent = `${allImages.length} 张图片`;
            header.style.display = '';

            renderGrid(allImages);
            loadingEl.style.display = 'none';
            grid.style.display = '';
            selectionInfo.style.display = '';
            filenameSection.style.display = '';
            btnGroup.style.display = '';
            updateSelectionUI();
            syncTaskControls();
        } catch (error) {
            console.error('[Pixiv 提取] 异常:', error);
            showError(getErrorMessage(error, '提取过程中发生错误'));
        }
    }

    // ─── 后台任务状态 ───
    async function restoreBackgroundJob() {
        try {
            const response = await sendBackgroundRequest('get-download-job');
            if (response.state) applyBackgroundJobState(response.state);
        } catch (error) {
            console.error('[后台任务] 恢复状态失败:', error);
            setStatus(`无法读取后台任务：${getErrorMessage(error, '未知错误')}`, 'error');
        }
    }

    function applyBackgroundJobState(state) {
        if (!state) return;

        isBusy = ACTIVE_JOB_STATUSES.has(state.status);
        currentJobId = isBusy ? state.jobId : null;
        currentJobStatus = state.status;
        syncTaskControls();

        const statusType = state.status === 'error' || (state.status === 'completed' && state.failed > 0)
            ? 'error'
            : state.status === 'completed' ? 'success' : 'info';
        setStatus(state.message || '后台任务状态已更新', statusType);
    }

    function beginSubmittingJob() {
        if (isBusy) return false;

        isBusy = true;
        currentJobId = null;
        currentJobStatus = 'submitting';
        cancelBtn.textContent = '正在提交...';
        cancelBtn.disabled = true;
        syncTaskControls();
        return true;
    }

    function resetSubmittingJob() {
        isBusy = false;
        currentJobId = null;
        currentJobStatus = null;
        cancelBtn.textContent = '停止后台任务';
        cancelBtn.disabled = false;
        syncTaskControls();
    }

    function syncTaskControls() {
        filenameInput.disabled = isBusy;
        zipBatchSizeInput.disabled = isBusy;
        cancelBtn.style.display = isBusy ? 'block' : 'none';

        if (isBusy && currentJobId) {
            const isCancelling = currentJobStatus === 'cancelling';
            cancelBtn.textContent = isCancelling ? '正在停止...' : '停止后台任务';
            cancelBtn.disabled = isCancelling;
        }
        updateSelectionUI();
    }

    async function cancelBackgroundJob() {
        if (!isBusy || !currentJobId || cancelBtn.disabled) return;

        cancelBtn.disabled = true;
        cancelBtn.textContent = '正在停止...';
        setStatus('正在停止后台任务，已经创建的下载不会取消', 'info');

        try {
            const response = await sendBackgroundRequest('cancel-download-job', {
                jobId: currentJobId
            });
            if (response.state) applyBackgroundJobState(response.state);
        } catch (error) {
            cancelBtn.disabled = false;
            cancelBtn.textContent = '停止后台任务';
            setStatus(`停止失败：${getErrorMessage(error, '未知错误')}`, 'error');
        }
    }

    async function submitBackgroundJob(job) {
        try {
            const response = await sendBackgroundRequest('start-download-job', { job });
            applyBackgroundJobState(response.state);
        } catch (error) {
            resetSubmittingJob();
            throw error;
        }
    }

    function sendBackgroundRequest(action, payload = {}) {
        return chrome.runtime.sendMessage({
            target: 'background',
            action,
            ...payload
        }).then(response => {
            if (!response?.success) {
                throw new Error(response?.error || '后台服务无响应');
            }
            return response;
        });
    }

    // ─── 渲染与选择 ───
    function renderGrid(images) {
        grid.replaceChildren();

        images.forEach((image, index) => {
            const card = document.createElement('div');
            card.className = 'image-card';
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
    }

    function toggleSelect(index) {
        if (isBusy) return;

        selectedIndices.has(index) ? selectedIndices.delete(index) : selectedIndices.add(index);
        updateSelectionUI();
    }

    function updateSelectionUI() {
        grid.querySelectorAll('.image-card').forEach((card, index) => {
            const isSelected = selectedIndices.has(index);
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
        downloadBtn.textContent = count > 0 ? `后台下载 (${count})` : '后台下载';

        zipBtn.disabled = isBusy || count === 0;
        zipBtn.textContent = count > getZipBatchSize()
            ? `后台分卷 (约 ${estimatedParts} 卷)`
            : count > 0 ? `后台打包 (${count})` : '后台打包';
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

            setStatus('正在提交后台下载任务...', 'info');
            await submitBackgroundJob({ type: 'direct', images });
        } catch (error) {
            resetSubmittingJob();
            console.error('[后台下载] 启动失败:', error);
            setStatus(`后台下载启动失败：${getErrorMessage(error, '未知错误')}`, 'error');
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

            setStatus('正在提交后台打包任务...', 'info');
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
            setStatus(`后台打包启动失败：${getErrorMessage(error, '未知错误')}`, 'error');
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
        statusText.className = `status-text status-${type}`;
    }
});
