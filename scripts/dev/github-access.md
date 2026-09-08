# GitHub 自主接入(供 agent 未来会话复用)

## 现状
- **git push 自主推送**:✅ 可用。令牌存于 `%USERPROFILE%\.deeplab-gh-token`(明文,不进仓库),
  已写入 `%USERPROFILE%\.git-credentials` 并配置 `credential.https://github.com.helper=store`,
  因此直接 `git push github main` 即可,无需每次输入令牌。
- **gh CLI(建仓库/issues/PR)**:⚠️ 需要令牌含 `read:org` 作用域;当前令牌仅 `repo`,
  `gh auth login --with-token` 会报 missing required scope 'read:org'。若要用 gh,需新生成一把
  scope = `repo` + `read:org` 的 PAT 覆盖保存到该文件,再执行:
  ```powershell
  $env:HOME=$env:USERPROFILE
  (Get-Content "$env:USERPROFILE\.deeplab-gh-token" -Raw).Trim() |
    & 'C:\Program Files\GitHub CLI\gh.exe' auth login --with-token
  ```
- 凭据冲突排查:若出现 `Invalid username or token` 而令牌有效,通常是 Windows Credential Manager
  残留旧凭据,删除 `git:https://github.com` 条目即可:
  ```powershell
  cmdkey /delete:LegacyGeneric:target=git:https://github.com
  ```

## 新会话接入步骤(每次开会话若需要推 GitHub)
```powershell
$env:HOME=$env:USERPROFILE
# git push 直接用(已配 store);若 store 未生效,重写:
# (Get-Content "$env:USERPROFILE\.deeplab-gh-token" -Raw).Trim() | Out-File -Encoding ascii "$env:USERPROFILE\.git-credentials-tmp" ... (改用 git credential fill)
git push github main
```

## 安全
- `.deeplab-gh-token` 与 `.git-credentials` 为明文,仅本机用户可读;不要提交、不要粘贴到对话。
- 令牌若曾在对话/外部出现 → 立刻去 GitHub Revoke,并生成新 PAT 覆盖该文件。
- 建议定期轮换(在 GitHub Developer settings → Tokens 管理)。
