# runtime/dsh-profile

DeepLab ships this profile alongside the bundled DeepSeek Harness runtime. The
desktop app starts dsh with an app-private `DSH_HOME`, so profile state does not
modify a user's global Harness installation.

## Contents

```text
agent/             # dsh agent presets
command/           # dsh slash commands
```

Skills are packaged from `runtime/skills/` and deployed into the private dsh
home by the desktop runtime. Provider credentials are written through dsh's
`credentials.*` RPC domain and must never be committed here.

Keep this directory versioned with the app. It must not contain user keys,
sessions, machine-specific paths, or generated state.
