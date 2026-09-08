# Publish this repository (entire history) to NEW public GitHub + Gitee repos.
# Tokens stay on this machine: set them in this shell before running; nothing is
# written to disk or committed.
#
# Usage (run from this repo's root):
#   $env:GH_TOKEN = "ghp_..."       # GitHub classic PAT with `repo` scope
#   $env:GITEE_TOKEN = "..."        # Gitee private token with `projects` scope
#   $env:GH_USER  = "your-github-name"
#   $env:GT_USER  = "your-gitee-name"
#   $repo = "deep-lab"              # optional override
#   powershell -ExecutionPolicy Bypass -File scripts\dev\publish-github-gitee.ps1
$ErrorActionPreference = "Stop"
$repo = if ($repo) { $repo } else { "deep-lab" }
if (-not $env:GH_TOKEN -or -not $env:GITEE_TOKEN) { throw "set GH_TOKEN and GITEE_TOKEN first" }
if (-not $env:GH_USER -or -not $env:GT_USER) { throw "set GH_USER and GT_USER first" }

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $root
Write-Host "repo root: $root"

function New-GithubRepo($name, $token, $user) {
  $body = @{ name = $name; private = $false; description = "DeepLab - OpenLab workbench migrated to the DeepSeek Harness (dsh)" } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "https://api.github.com/user/repos" `
    -Headers @{ Authorization = "Bearer $token"; Accept = "application/vnd.github+json"; "User-Agent" = "deeplab-publish" } `
    -ContentType "application/json" -Body $body
  return "https://github.com/$user/$name.git"
}

function New-GiteeRepo($name, $token, $user) {
  $body = @{ name = $name; private = $false; description = "DeepLab - OpenLab workbench migrated to the DeepSeek Harness (dsh)" } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "https://gitee.com/api/v5/user/repos?access_token=$token" `
    -ContentType "application/json;charset=UTF-8" -Body $body
  return "https://gitee.com/$user/$name.git"
}

$githubUrl = New-GithubRepo $repo $env:GH_TOKEN $env:GH_USER
Write-Host "github repo ready: $githubUrl"
$giteeUrl = New-GiteeRepo $repo $env:GITEE_TOKEN $env:GT_USER
Write-Host "gitee repo ready: $giteeUrl"

# Add (or refresh) remotes without touching any existing origin (upstream).
git remote remove github 2>$null
git remote remove gitee  2>$null
git remote add github "https://$env:GH_USER`:$env:GH_TOKEN@github.com/$env:GH_USER/$repo.git"
git remote add gitee  "https://$env:GT_USER`:$env:GITEE_TOKEN@gitee.com/$env:GT_USER/$repo.git"

# Push the complete history (all branches and tags) to both new empty repos.
git push -f github "refs/heads/*:refs/heads/*" "refs/tags/*:refs/tags/*"
git push -f gitee  "refs/heads/*:refs/heads/*" "refs/tags/*:refs/tags/*"

# Store clean URLs (no token) so future pushes ask for credentials normally.
git remote set-url github "https://github.com/$env:GH_USER/$repo.git"
git remote set-url gitee  "https://gitee.com/$env:GT_USER/$repo.git"

Write-Host ""
Write-Host "Done. Public repos:"
Write-Host "  GitHub: https://github.com/$env:GH_USER/$repo"
Write-Host "  Gitee : https://gitee.com/$env:GT_USER/$repo"
