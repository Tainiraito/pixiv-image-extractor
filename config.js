// config.js — 扩展运行配置（弹窗与后台共享）

(() => {
    const MEBIBYTE = 1024 * 1024;

    const config = Object.freeze({
        // 单次后台任务允许处理的图片总数上限。
        MAX_JOB_IMAGES: 1000,

        // ZIP 每卷图片数量
        ZIP_IMAGES_PER_PART: Object.freeze({
            DEFAULT: 30,
            MIN: 1,
            MAX: 100
        }),

        // ZIP 每卷容量限制。图片数量未达到上限时，也可能因容量达到上限而提前分卷。
        ZIP_BYTES_PER_PART: Object.freeze({
            DEFAULT: 100 * MEBIBYTE,
            MIN: 20 * MEBIBYTE,
            MAX: 200 * MEBIBYTE
        })
    });

    // 使用只读全局对象，兼容 Manifest V3 Service Worker 与普通扩展页面。
    Object.defineProperty(globalThis, 'PIXIV_EXTRACTOR_CONFIG', {
        value: config,
        writable: false,
        configurable: false
    });
})();
