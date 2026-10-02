# Pixiv 图片提取 v1.3.0

从 Pixiv 作品页面提取高清图片，支持预览、勾选、后台下载和自动分卷打包。

## 功能

- 🖼️ 自动识别作品页面所有图片
- ✅ 网格预览 + 勾选想要保存的图片
- 📥 逐张下载选中的高清原图
- 📦 大型画廊自动分卷打包
- 📝 自定义下载文件名模板（支持占位符）
- 🎨 浅色主题 UI

## 安装

1. 下载本项目到本地
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择 `pixiv-image-extractor` 文件夹

## 使用

1. 打开 [Pixiv](https://www.pixiv.net/) 任意作品详情页（如 `pixiv.net/artworks/116299462`）
2. 点击浏览器工具栏中的扩展图标
3. 图片会自动提取并显示预览网格
4. 点击图片勾选/取消，或使用「全选」按钮
5. 可选：在输入框中设置文件名模板
6. 点击「后台下载」将原图加入 Chrome 下载队列，或点击「后台打包」生成 ZIP
7. 任务启动后可以切换标签页或关闭弹窗；重新打开弹窗可查看进度或停止任务

## 大型画廊与 ZIP 分卷

- 普通下载逐张获取并交给 Chrome 下载管理器，每次只在内存中保留一张原图
- ZIP 每卷张数可在弹窗中调整，默认值和范围统一由 `config.js` 管理
- 即使尚未达到图片数量上限，当前卷达到配置的容量上限时也会自动提前切卷
- 多卷文件使用 `_part001.zip`、`_part002.zip` 格式命名
- 下载与打包由后台隐藏文档执行，不依赖弹窗和当前标签页持续打开
- 「停止后台任务」只停止后续处理，已经加入 Chrome 下载队列的任务会继续执行
- 即使 Chrome 下载已暂停，也能停止后台处理并开始新任务；旧下载需要的 Blob 会保留到下载完成或中断，新任务复用隐藏文档
- 暂停的旧下载会继续占用相应图片或 ZIP 的内存，可在下载管理器中恢复或取消来释放资源

## 文件名模板

在下载前可自定义文件名格式，支持以下占位符：

| 占位符 | 含义 | 示例 |
|--------|------|------|
| `{id}` | 作品 ID | 116299462 |
| `{author}` | 作者名 | 鸦居 |
| `{title}` | 作品标题 | 星妲 |
| `{index}` | 页码 | 1 |

默认模板：`pixiv_{id}_{author}_{title}_p{index}`

示例：`{author}-{title}-p{index}` → `鸦居-星妲-p1.jpg`

## 文件说明

```
pixiv-image-extractor/
├── manifest.json      # 扩展配置（Manifest V3）
├── config.js          # 弹窗与后台共享的任务和 ZIP 配置
├── background.js      # 后台任务调度、状态持久化和下载管理
├── offscreen.html     # 后台隐藏文档入口
├── offscreen.js       # 普通下载与分卷 ZIP 执行器
├── content.js         # 内容脚本，调用 Pixiv API 提取图片
├── popup.js           # 弹出窗口逻辑（预览 + 下载）
├── popup.html         # 弹出窗口 UI（浅色主题）
├── rules.json         # declarativeNetRequest 规则（自动加 Referer 头）
├── lib/
│   └── jszip.min.js   # JSZip 库（打包下载用）
├── tests/
│   └── download-lifecycle.test.cjs # 后台任务生命周期回归测试
├── icon*.png          # 扩展图标
├── .gitignore         # Git 忽略配置
└── README.md          # 本文档
```

## 技术实现

- **提取策略**：调用 Pixiv 内部 API `/ajax/illust/{id}/pages` 获取所有图片 URL
- **后台架构**：Service Worker 调度任务并通过 `chrome.storage.session` 保存进度
- **任务状态**：启动、恢复、取消、进度写入及清理按同一队列串行处理；执行器就绪前使用 `starting` 状态
- **持续执行**：Offscreen Document 负责获取图片、生成 ZIP 和管理 Blob 生命周期
- **停止与清理**：停止后台处理与监控已提交下载分别执行；仅在无任务且无未完成下载时关闭隐藏文档
- **Referer 处理**：通过 `declarativeNetRequest` 规则自动为 i.pximg.net 请求添加 Referer 头
- **预览**：使用 regular 尺寸图片（master1200，约 1200px 宽）
- **下载**：后台逐张获取 original 原图并转换为同源 Blob，再交给 `chrome.downloads`
- **打包下载**：使用 JSZip 的 STORE 模式分卷生成 ZIP，避免对已压缩图片重复压缩
- **内存控制**：每个 ZIP 同时受 `config.js` 中的图片数量与容量配置限制

## 适配范围

- Chrome 116+（使用 Offscreen Document 和 `runtime.getContexts()`）
- Pixiv 作品详情页 `https://www.pixiv.net/artworks/*`

## 已知限制

- 需要 Pixiv 登录状态才能调用 API
- 下载保存到 Chrome 默认下载目录
- Ugoira（动图）暂不支持，会作为普通图片处理

## 本地回归测试

测试使用 Node.js 内置测试运行器，无需安装 npm 依赖。两个 VM 加载真实后台和隐藏文档脚本，模拟 Chrome API 与图片响应；ZIP 测试使用项目自带的 JSZip 并检查解包内容。

```powershell
node --test tests/download-lifecycle.test.cjs
```

若环境禁止测试运行器创建子进程，可使用 Node.js 24 的 `node --test --test-isolation=none tests/download-lifecycle.test.cjs`。

覆盖并发启动、启动期间恢复、worker 重启、暂停下载后停止、旧 Blob 与新任务共存、ZIP 分卷和下载中断等路径。这些回归测试不替代真实浏览器与 Pixiv 登录环境的验证。
