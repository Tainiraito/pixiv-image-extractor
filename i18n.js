// Own catalogs allow manual language selection independently of the browser locale.
globalThis.PixivI18n = (() => {
    const storageKey = 'pixiv_ui_language';
    const fallback = 'zh-CN';
    const catalogs = new Map();
    const listeners = new Set();
    let language = fallback, request = 0;
    let lastApplication = Promise.resolve(), saveQueue = Promise.resolve();
    const registry = PIXIV_LOCALES;
    function match(value) {
        const tag = String(value || '').replace(/_/g, '-').toLowerCase();
        return registry.find(locale => locale.code.toLowerCase() === tag)
            || registry.find(locale => locale.matches.includes(tag.split('-')[0]));
    }
    function resolve(saved, browserLanguage) {
        // An invalid stored preference falls back directly, rather than following the browser.
        return match(saved === undefined ? browserLanguage : saved)?.code || fallback;
    }
    async function load(code) {
        if (!catalogs.has(code)) {
            const locale = registry.find(item => item.code === code);
            const response = await fetch(chrome.runtime.getURL(locale.path));
            if (!response.ok) throw new Error('Cannot load language catalog: ' + code);
            catalogs.set(code, await response.json());
        }
    }
    async function apply(code) {
        const token = ++request;
        const next = match(code)?.code || fallback;
        await load(fallback);
        try { await load(next); } catch { if (next === fallback) throw new Error('Missing Chinese catalog'); }
        if (token !== request) return;
        language = catalogs.has(next) ? next : fallback;
        for (const listener of listeners) listener(language);
    }
    async function init() {
        // Listen before the asynchronous read; a concurrent setting change must win.
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && Object.hasOwn(changes, storageKey)) {
                lastApplication = apply(resolve(changes[storageKey].newValue, getBrowserLanguage()));
                lastApplication.catch(console.error);
            }
        });
        const token = request;
        const result = await chrome.storage.local.get(storageKey);
        if (token === request) lastApplication = apply(resolve(result[storageKey], getBrowserLanguage()));
        // Wait for whichever choice won during initialization before rendering.
        let pending;
        do { pending = lastApplication; await pending; } while (pending !== lastApplication);
    }
    function getBrowserLanguage() {
        try { return chrome.i18n.getUILanguage(); } catch { return fallback; }
    }
    function t(key, params = {}) {
        let value = catalogs.get(language)?.[key] ?? catalogs.get(fallback)?.[key] ?? key;
        if (typeof value === 'object') value = value[new Intl.PluralRules(language).select(Number(params.count))] ?? value.other;
        return String(value).replace(/\{(\w+)\}/g, (whole, name) => {
            if (!Object.hasOwn(params, name)) return whole;
            return typeof params[name] === 'number' ? new Intl.NumberFormat(language).format(params[name]) : String(params[name]);
        });
    }
    function render(root = document) {
        document.documentElement.lang = language;
        document.documentElement.dir = registry.find(item => item.code === language).dir;
        for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
        for (const attribute of ['title', 'aria-label']) {
            for (const node of root.querySelectorAll('[data-i18n-' + attribute + ']')) {
                node.setAttribute(attribute, t(node.getAttribute('data-i18n-' + attribute)));
            }
        }
    }
    async function select(code) {
        const next = registry.some(locale => locale.code === code) ? code : fallback;
        // Apply only persisted choices, keeping all open popup instances consistent.
        const save = saveQueue.then(() => chrome.storage.local.set({ [storageKey]: next }));
        // Serialize storage writes, but never block a newer choice on an older catalog fetch.
        saveQueue = save.catch(() => {});
        await save;
        // storage.onChanged applies the choice to every open instance.
        await lastApplication;
    }
    return { init, select, resolve, t, render, registry, storageKey,
        onChange(fn) { listeners.add(fn); }, get language() { return language; } };
})();
