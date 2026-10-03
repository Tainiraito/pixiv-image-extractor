# 项目协作规则 / Project Agent Instructions

本文件适用于整个仓库，所有在此项目中工作的 LLM、编码代理和贡献者应遵守。

These instructions apply throughout this repository to all LLMs, coding agents, and contributors working on the project.

## 文档与发布 / Documentation and releases

- 修改 README、Release 或用户可见行为前，必须阅读并遵守 [docs/DOCUMENTATION_GUIDE.md](docs/DOCUMENTATION_GUIDE.md)。这是项目规范，不是可选参考。
- Before changing READMEs, release notes, or user-visible behavior, read and follow [docs/DOCUMENTATION_GUIDE.md](docs/DOCUMENTATION_GUIDE.md). It is a required project standard, not an optional reference.
- 用户文档至少提供完整的简体中文和英文。同步维护 `README.md` 与 `README.en.md`，核对两种语言的功能、限制、数值、链接及实际按钮名称。
- User documentation must provide complete Simplified Chinese and English versions. Maintain `README.md` and `README.en.md` together and verify that features, limitations, values, links, and actual button labels match.
- 每次完成调整后检查 README 和相关文档，让文档与实际行为一致；不要把聊天记录、代理设置、审批过程或本地绝对路径写入公开说明。
- After completing changes, check READMEs and related documentation against actual behavior. Do not put chat history, proxy settings, approval mechanics, or local absolute paths into public documentation.
- Release 文案在 `docs/releases/vX.Y.Z.md` 中维护，再用于 GitHub 发布；中文与英文均需包括重要变更和升级影响。不要直接把 Git 日志当成发布说明。
- Maintain release notes in `docs/releases/vX.Y.Z.md` before publishing them on GitHub. Both languages must cover notable changes and upgrade impact. Do not use raw Git logs as release notes.
- 发布前核对 manifest 版本、tag、文案、附件名称与包内版本。纯文案整理不自动升版，不移动已发布 tag，也不擅自替换已发布安装包。
- Before publishing, verify the manifest version, tag, notes, asset name, and packaged version. Copy edits do not automatically bump the version, move published tags, or replace published assets.
- 本规范已经用户确认，后续例行文档修改直接按规范执行，无需重复请求确认。发布、推送等操作仍须遵循当前任务的授权范围。
- This standard has been approved. Apply it to routine documentation work without requesting approval again. Publishing and pushing must still remain within the current task's authorization.

## 本地化 / Localization

- 修改界面文案或后台用户提示时，遵守 [docs/LOCALIZATION.md](docs/LOCALIZATION.md)，同步所有语言目录。任务持久化使用稳定文案键和参数，避免保存翻译后的提示。切换语言不得重启下载或丢失选择。
- Follow [docs/LOCALIZATION.md](docs/LOCALIZATION.md) for UI and service messages, updating every catalog. Persist stable message keys and parameters, not translated messages. Language changes must preserve downloads and selection.

## 网络连接 / Network connections

优先直连；直连失败后可临时使用下列代理，仅对当前命令或会话生效，不写入仓库或永久 Git 配置。

Try a direct connection first. If it fails, temporarily use the proxy below for the current command or session only. Do not store it in the repository or permanent Git configuration.

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
```
