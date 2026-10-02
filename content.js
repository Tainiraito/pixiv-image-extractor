// content.js — Pixiv 图片提取 v1.3.0
// 在 Pixiv 作品页面提取所有图片 URL 和作品信息
// Referer 头由 declarativeNetRequest 规则自动添加

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 只处理本扩展自身发出的消息，避免其他来源触发带登录态的 Pixiv API 请求。
    if (sender.id === chrome.runtime.id && message?.action === 'extract-images') {
        handleExtract()
            .then(sendResponse)
            .catch(err => sendResponse({ success: false, error: err.message || '未知错误' }));
        return true;
    }
});

// ─── 主流程 ───

async function handleExtract() {
    const artworkId = extractArtworkId();
    if (!artworkId) {
        return { success: false, error: '无法识别作品 ID，请确认在作品详情页' };
    }

    const [detail, pages] = await Promise.all([
        fetchArtworkDetail(artworkId),
        fetchArtworkPages(artworkId)
    ]);

    if (!pages || pages.length === 0) {
        return { success: false, error: '未找到图片，请确认作品存在' };
    }

    return {
        success: true,
        artworkId,
        title: detail?.title || '未知作品',
        author: detail?.author || '未知作者',
        pageCount: pages.length,
        images: pages.map((page, i) => ({
            index: i + 1,
            previewUrl: page.urls.regular,
            originalUrl: page.urls.original
        }))
    };
}

// ─── 从 URL 提取作品 ID ───

function extractArtworkId() {
    const match = window.location.pathname.match(/\/artworks\/(\d+)/);
    return match ? match[1] : null;
}

// ─── API: 获取作品详情 ───

async function fetchArtworkDetail(artworkId) {
    try {
        const resp = await fetch(`https://www.pixiv.net/ajax/illust/${artworkId}`);
        if (!resp.ok) return null;

        const data = await resp.json();
        if (data.error) return null;

        return {
            title: data.body?.illustTitle || data.body?.title || null,
            author: data.body?.userName || null
        };
    } catch {
        return null;
    }
}

// ─── API: 获取所有图片页面 URL ───

async function fetchArtworkPages(artworkId) {
    const resp = await fetch(`https://www.pixiv.net/ajax/illust/${artworkId}/pages`);
    if (!resp.ok) {
        throw new Error(`获取图片列表失败：HTTP ${resp.status}`);
    }

    const data = await resp.json();
    if (data.error || !Array.isArray(data.body)) {
        throw new Error(data.message || 'Pixiv 返回的图片列表格式异常');
    }

    return data.body;
}
