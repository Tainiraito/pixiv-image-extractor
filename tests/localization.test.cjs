const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const chinese = JSON.parse(read('locales/zh-CN.json'));

function fixture(options = {}) {
    const data = options.saved === undefined ? {} : { pixiv_ui_language: options.saved };
    const events = [];
    let writes = 0;
    const sandbox = vm.createContext({ console, Intl, Object, Map, Set,
        chrome: {
            i18n: { getUILanguage() { if (options.localeError) throw new Error('No locale'); return options.browser || 'en-US'; } },
            runtime: { getURL: name => name },
            storage: {
                onChanged: { addListener(fn) { events.push(fn); } },
                local: {
                    async get() { if (options.onRead) await options.onRead(change); return { ...data }; },
                    async set(values) { writes++; Object.assign(data, values); change(values.pixiv_ui_language); }
                }
            }
        },
        async fetch(name) {
            if (options.load) await options.load(name);
            return { ok: true, json: async () => {
                const catalog = JSON.parse(read(name));
                if (options.missingKey && name.endsWith('en.json')) delete catalog[options.missingKey];
                return catalog;
            } };
        }
    });
    function change(value, area = 'local') {
        data.pixiv_ui_language = value;
        for (const listener of events) listener({ pixiv_ui_language: { newValue: value } }, area);
    }
    vm.runInContext(read('locales/index.js'), sandbox);
    vm.runInContext(read('messages.js'), sandbox);
    vm.runInContext(read('i18n.js'), sandbox);
    return { i18n: sandbox.PixivI18n, messages: sandbox.PixivMessages, change, data, get writes() { return writes; } };
}
async function until(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('Language update did not arrive');
}

test('every registered catalog has identical keys and named parameters', () => {
    const f = fixture();
    const keys = Object.keys(chinese).sort();
    function parameters(value) {
        const forms = typeof value === 'string' ? [value] : Object.values(value);
        assert.ok(forms.every(form => typeof form === 'string' && form.length > 0));
        const extract = form => [...new Set([...form.matchAll(/\{(\w+)\}/g)].map(match => match[1]))].sort();
        const expected = extract(forms[0]);
        for (const form of forms) assert.deepEqual(extract(form), expected);
        return expected;
    }
    for (const locale of f.i18n.registry) {
        const catalog = JSON.parse(read(locale.path));
        assert.deepEqual(Object.keys(catalog).sort(), keys, locale.code);
        for (const key of keys) assert.deepEqual(parameters(catalog[key]), parameters(chinese[key]), locale.code + ': ' + key);
    }
    // Catch misspelled source keys in static markup and literal dynamic calls.
    const source = ['popup.html','popup.js','task-runtime.js','background.js','offscreen.js','content.js','messages.js']
        .map(read).join('\n');
    const patterns = [/data-i18n(?:-title|-aria-label)?="([^"]+)"/g,
        /(?:t|make|error|describe|fromResponse)\(\s*'((?:error|job|task|settings|gallery|selection|action|status|download|notice|images|app|history|artwork|author|extract)\.[^']+)'/g];
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) assert.ok(Object.hasOwn(chinese, match[1]), match[1]);
});

test('browser defaults, manual priority and invalid preferences use the agreed fallback', async () => {
    for (const [browser, saved, expected] of [
        ['en-US', undefined, 'en'], ['EN_gb', undefined, 'en'], ['zh-TW',undefined,'zh-CN'],
        ['ja',undefined,'zh-CN'], ['fr-FR',undefined,'zh-CN'], ['en', 'zh-CN','zh-CN'],
        ['zh-CN','en','en'], ['en','unknown','zh-CN'], ['en',null,'zh-CN'], ['en','','zh-CN']
    ]) {
        const f = fixture({browser,saved}); await f.i18n.init();
        assert.equal(f.i18n.language,expected); assert.equal(f.writes,0);
    }
    const f = fixture({localeError:true}); await f.i18n.init(); assert.equal(f.i18n.language,'zh-CN');
});

test('manual choices persist, synchronize and removing a preference follows the browser', async () => {
    const f = fixture({browser:'en-US'}); await f.i18n.init();
    await f.i18n.select('zh-CN');
    assert.equal(f.data.pixiv_ui_language,'zh-CN'); assert.equal(f.i18n.language,'zh-CN');
    f.change('en'); await until(()=>f.i18n.language==='en');
    f.change(undefined); await until(()=>f.i18n.language==='en');
    f.change('zh-CN','session'); assert.equal(f.i18n.language,'en');
});

test('a language change during the initial read wins before initialization finishes', async () => {
    const f = fixture({browser:'zh-CN', onRead: async change=>change('en')});
    await f.i18n.init();
    assert.equal(f.i18n.language,'en'); assert.equal(f.i18n.t('download.single'),'Download');
});

test('rapid selections retain the latest choice even when the first catalog load is delayed', async () => {
    let release, requested = false;
    const gate = new Promise(resolve=>{release=resolve;});
    const f = fixture({browser:'zh-CN', load: async name=>{if(name.endsWith('en.json')) { requested = true; await gate; }}});
    await f.i18n.init();
    const first = f.i18n.select('en');
    await until(()=>requested);
    const second = f.i18n.select('zh-CN');
    await second;
    assert.equal(f.i18n.language,'zh-CN');
    release(); await first;
    assert.equal(f.data.pixiv_ui_language,'zh-CN'); assert.equal(f.i18n.language,'zh-CN');
});

test('English plurals, numeric parameters and missing keys render safely', async () => {
    const f = fixture({browser:'en', missingKey:'action.pause'}); await f.i18n.init();
    assert.equal(f.i18n.t('images.count',{count:1}),'1 image');
    assert.equal(f.i18n.t('images.count',{count:2}),'2 images');
    assert.equal(f.i18n.t('images.count',{count:1000}),'1,000 images');
    assert.equal(f.i18n.t('action.pause'),'暂停');
    assert.equal(f.i18n.t('settings.placeholders'),JSON.parse(read('locales/en.json'))['settings.placeholders']);
    assert.equal(f.i18n.t('gallery.image',{index:'<script>alert(1)</script>'}), 'Image <script>alert(1)</script>');
});

test('service errors and task messages stay locale-independent across serialization', async () => {
    const f = fixture({browser:'en'}); await f.i18n.init();
    const error = f.messages.error('error.imageHttp',{status:500});
    const record = JSON.parse(JSON.stringify(f.messages.describe(error)));
    assert.equal(record.message,''); assert.equal(record.messageKey,'error.imageHttp');
    assert.equal(f.i18n.t(record.messageKey,record.messageParams),'Image request failed: HTTP 500');
    await f.i18n.select('zh-CN');
    assert.equal(f.i18n.t(record.messageKey,record.messageParams),'图片请求失败：HTTP 500');
    const external = f.messages.describe(new Error('NETWORK_ERROR'));
    assert.equal(external.messageParams.detail,'NETWORK_ERROR');
    const restored = f.messages.fromResponse({success:false,...record});
    assert.equal(restored.messageKey,'error.imageHttp');
});
