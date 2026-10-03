# 本地化 / Localization

## 语言选择 / Language selection

手动偏好保存在 `chrome.storage.local` 的 `pixiv_ui_language`。没有偏好时读取 `chrome.i18n.getUILanguage()`；英语变体匹配英语，中文及未知语言回退简体中文。自动默认值不写入存储。删除偏好后，重新跟随浏览器界面语言。

Manual preferences use `pixiv_ui_language` in `chrome.storage.local`. With no preference, read `chrome.i18n.getUILanguage()`: English variants select English; Chinese and unknown languages fall back to Simplified Chinese. Automatic defaults are never saved. Removing the preference restores browser detection.

## 文案与任务 / Messages and tasks

- 静态界面使用 `data-i18n` 或明确的 `data-i18n-title` / `data-i18n-aria-label`，动态文案使用 `PixivI18n.t(key, params)`。只写入 `textContent` 和受控属性，不把翻译作为 HTML。
- Static UI uses `data-i18n` or explicit title/ARIA attributes; dynamic UI uses `PixivI18n.t(key, params)`. Write text and controlled attributes; never render translations as HTML.
- 消息通过 `messages.js` 保存或发送 `messageKey` 与 `messageParams`，不要将本地化后的字符串写进新任务记录。错误使用 `PixivMessages.error`；原始外部诊断保存在参数中。
- Store or send `messageKey` and `messageParams` using `messages.js`, rather than localized strings in new task records. Use `PixivMessages.error` for errors; preserve external diagnostics in parameters.
- 旧记录从状态和数量生成当前语言的摘要；未知的历史错误详情保留原文，不猜测替换，不删除记录。作品信息和文件名模板不翻译。
- Derive localized summaries from structured fields in older records. Preserve unknown old error details without guessing or deleting records. Do not translate artwork metadata or filename templates.

## 扩展语言 / Adding languages

1. 添加 `locales/<code>.json`，与中文目录保持相同语义键和参数。需要复数时使用 `one` / `other` 等 Intl.PluralRules 类别；数字参数由 Intl.NumberFormat 格式化。
2. 在 `locales/index.js` 注册代码、原生名称、目录路径、方向和匹配的语言前缀。缺少文案时运行时回退中文；提交前必须保证目录完整。
3. 运行 `node --test tests/*.test.cjs`，并在真实浏览器检查设置、任务卡片、对话框、错误提示和下载中切换。RTL 语言需要额外布局验证和调整。
4. 同步中英文 README 与发布说明。本地化不增加权限或外部服务。

1. Add `locales/<code>.json` with the same semantic keys and parameters as Chinese. Use Intl.PluralRules categories for plurals; numeric parameters use Intl.NumberFormat.
2. Register its code, native name, catalog path, direction, and matching language prefixes in `locales/index.js`. Missing messages fall back to Chinese at runtime; submitted catalogs must be complete.
3. Run `node --test tests/*.test.cjs` and check settings, task cards, dialogs, errors, and switching during downloads in a real browser. RTL languages need additional layout validation and changes.
4. Update both READMEs and release notes. Localization requires no extra permissions or external services.
