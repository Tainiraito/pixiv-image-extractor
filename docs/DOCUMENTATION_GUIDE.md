# README 与 Release 写作规范 / README and Release Writing Guide

**已确认的项目规范。 / Approved project standard.**

适用范围：本项目面向用户的 README 与 GitHub Release。根目录 `AGENTS.md` 要求所有代理与贡献者遵守本文。

Scope: user-facing READMEs and GitHub releases for this project. The root `AGENTS.md` requires all agents and contributors to follow this guide.

## 基本原则 / Principles

| 规范 | Rule |
| --- | --- |
| 先写用户能做什么、如何开始，再写实现细节。用具体行为描述收益，避免宣传口号。 | Lead with what users can do and how to start. Describe concrete behavior before implementation details; avoid marketing claims. |
| README 介绍当前项目，Release 介绍本次发布相对上一版本的变化。功能清单、使用步骤和变更记录各自承担不同作用，避免重复。 | READMEs describe the current project; releases describe changes since the previous version. Keep feature lists, instructions, and change notes distinct to avoid repetition. |
| 至少提供完整的中文与英文，功能、限制、数字、链接和升级提示一致；英文自然表达，不逐字硬译。 | Provide complete Chinese and English versions with matching features, limitations, numbers, links, and upgrade guidance. Use natural English instead of literal translation. |
| 文档语言与产品界面语言分别描述。英文文档不能暗示界面已经英文化；实际按钮为中文时，英文步骤给出对应中文标签。 | Distinguish documentation languages from interface languages. English documentation must not imply an English interface; include the actual Chinese labels in English instructions. |
| 短段落与简洁列表为主，按需使用表格。标题中不堆叠 emoji，不添加无实际信息的徽章。 | Prefer short paragraphs and concise lists, using tables when useful. Avoid decorative emoji in headings and badges without useful information. |
| 不写代理、本地绝对路径、自动审批、工具身份、聊天过程或审查流水。验证证据保留在开发文档或 PR 中，重大未验证兼容性才在公开说明中交代。 | Exclude proxies, local absolute paths, approval mechanics, tool identities, chat history, and review diaries. Keep validation evidence in development docs or PRs; surface material unverified compatibility when relevant. |
| 不虚构许可证、兼容性、截图、测试覆盖或功能。界面截图须来自实际运行，且不含私密数据或测试夹具冒充的真实作品。 | Do not invent licenses, compatibility, screenshots, test coverage, or capabilities. Screenshots must show the actual application without private data or test fixtures presented as real artwork. |

## README

中文主文档使用 `README.md`，英文使用 `README.en.md`，顶部互相链接。两份文档按相同顺序维护。

Use `README.md` for Chinese and `README.en.md` for English, linked at the top. Maintain the same section order in both.

建议结构 / Recommended structure:

1. 项目名、语言入口、一句话用途、下载/反馈入口 / Project name, language links, a one-sentence purpose, download and feedback links.
2. 少量核心功能 / A short list of core features.
3. 安装：环境要求、可用安装包、可执行步骤、更新方式 / Installation: requirements, available package, actionable steps, and update instructions.
4. 使用：从打开页面到下载完成的主要流程 / Usage: the main flow from opening an artwork page to downloading.
5. 任务与配置：影响用户操作的状态和参数 / Tasks and settings: states and parameters that affect user actions.
6. 支持范围与实际限制 / Supported scope and actual limitations.
7. 反馈与简要开发入口 / Feedback and brief development instructions.

README 标题不绑定版本号；链接到最新 Release 查看版本，避免每次发版重复更新多个位置。完整更新日志放在 Releases，需要长期独立保存时再增加 CHANGELOG。较长架构说明应移到开发文档，简短说明可折叠。

Do not put a version number in the README title. Link to the latest release instead of maintaining redundant version labels. Keep full change notes in Releases; add a CHANGELOG if a separate long-term history is needed. Move lengthy architecture notes into development docs, or fold brief notes into a collapsible section.

## Release

发布标题建议仅用 `vX.Y.Z`，用正文第一句概括本次变化。正文提供「简体中文」与「English」两个完整部分，并在顶部提供锚点导航。

Use `vX.Y.Z` as the release title and summarize the release in the opening sentence. Include complete Chinese and English sections with anchor links at the top.

- 按「新增 / Added」「改进 / Changed」「修复 / Fixed」分组；仅在确有对应内容时增加移除、弃用或安全分组，不保留空分组。
- Group changes as Added, Changed, and Fixed. Add Removed, Deprecated, or Security only when applicable, and omit empty sections.
- 每条写明确的功能或问题及结果。修复说明使用用户能观察到的症状，避免只写函数名、commit 标题或“优化体验”。
- Each entry states a specific feature or problem and its result. Describe observable symptoms rather than function names, raw commit titles, or vague claims such as “improved experience.”
- 选择变更范围时注明依据：GitHub Release 默认与上一个公开 Release 比较；内部版本未单独发布时，其重要变更应覆盖，并在升级提示中说明旧版本兼容性变化。
- State the comparison basis: GitHub releases normally compare against the previous public release. Include important changes from intermediate versions that were not publicly released, and explain compatibility changes for upgrading users.
- 浏览器最低版本、数据迁移、设置失效等会影响升级的变化，必须在升级提示中明确说明。没有相关变化时不要套用空泛警告。
- Explain upgrade-impacting changes such as browser requirements, data migration, or invalidated settings. Do not add generic warnings when none apply.
- 下载链接必须指向真实附件，安装或升级说明简洁可执行，最后提供真实 tag 的完整变更链接。重大外部贡献可链接到贡献者和 PR。
- Link downloads to real assets, keep installation or upgrade steps actionable, and link the full comparison using actual tags. Credit substantial external contributions with contributor and PR links.

## 维护与检查 / Maintenance and review

- 修改功能时同步两种语言；发布前核对 manifest 版本、tag、正文版本、安装包文件名，以及默认值、范围、任务上限和页面按钮名称。
- Update both languages when behavior changes. Before publishing, verify the manifest version, tag, release version, asset name, defaults, ranges, task limits, and actual button labels.
- 检查 Markdown 标题、列表、表格、代码块、折叠块和相对链接；中英文逐节核对。文案整理不要求重复运行无关的程序测试。
- Check Markdown headings, lists, tables, code blocks, collapsible sections, and relative links. Compare Chinese and English section by section. Copy edits do not require unrelated application tests.
- 本规范已由用户确认，后续日常维护直接遵守。发布和推送依当前任务授权执行，不为每次文案修改增加重复确认。
- This standard has been approved. Apply it to routine maintenance. Follow the current task authorization for publishing and pushing; do not add a repeated approval gate for every copy edit.
- 整理文档不自动提高软件版本，不移动已发布的 tag，不悄悄替换安装包。更新已发布 Release 文案与发布新版本分别处理。
- Documentation cleanup does not automatically bump the software version, move published tags, or silently replace release assets. Treat editing published notes separately from publishing a new version.

## 参考 / References

- [GitHub：About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)：README 的读者目标、快速开始与文档分层。
- [GitHub CLI README](https://github.com/cli/cli/blob/trunk/README.md)：直接说明用途，并提供清晰的安装与文档入口。
- [VS Code README](https://github.com/microsoft/vscode/blob/main/README.md)：概述项目，将贡献和更长的开发内容链接到独立文档。
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)：筛选重要变更、按类型分组，说明版本间差异。
- [GitHub CLI Releases](https://github.com/cli/cli/releases)：按变化类型组织条目，链接关联 PR 和完整变更。

以上是本项目采用的约定，并非 GitHub 强制格式。

These are adopted conventions for this project, not a mandatory GitHub format.
