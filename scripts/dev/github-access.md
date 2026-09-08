# GitHub 自主接入(供 agent 未来会话复用)

## 现状
- **git push 自主推送**:✅ 可用。已执行 `gh auth setup-git`(写入了用户全局 git 配置),
  git 经 GitHub CLI 凭据访问;直接 `git push github main` 即可。
- **gh CLI(建仓库/issues/PR)**:✅ 可用(令牌含 `repo` + `read:org`)。
- 令牌源文件:`%USERPROFILE%\.deeplab-gh-token`(明文,不进仓库)。

## 新会话接入步骤
每次开会话(我的运行环境需显式设置 HOME 才能读到 gh/全局 git 配置):
```powershell
$env:HOME = $env:USERPROFILE
# gh(完整路径,避免 PATH 未刷新):
& 'C:\Program Files\GitHub CLI\gh.exe' auth status
# git push 直接用(已配 gh credential helper):
git push github main
```

## 安全
- `.deeplab-gh-token` 与 `.git-credentials` 为明文,仅本机用户可读;不要提交、不要粘贴到对话。
- 令牌若曾在对话/外部出现 → 立刻去 GitHub Revoke,并生成新 PAT 覆盖该文件。
- 建议定期轮换(在 GitHub Developer settings → Tokens 管理)。
