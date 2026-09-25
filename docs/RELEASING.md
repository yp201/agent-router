# Releasing

Two channels, same tree. Nothing is compiled; a release is a git tag.

## Cut a version
```bash
node --test test_router.ts                  # green
git tag v0.1.2 && git push origin v0.1.2    # semver: patch = fixes, minor = features, major = install/format change
```

## Update the Homebrew tap (yp201/homebrew-tap)
```bash
SHA=$(curl -sL https://github.com/yp201/agent-router/archive/refs/tags/v0.1.2.tar.gz | shasum -a 256 | cut -d' ' -f1)
cd /opt/homebrew/Library/Taps/yp201/homebrew-tap
sed -i '' -e "s|tags/v[0-9.]*\.tar\.gz|tags/v0.1.2.tar.gz|" -e "s|sha256 \"[0-9a-f]*\"|sha256 \"$SHA\"|" Formula/agent-router.rb
git commit -am "agent-router 0.1.2" && git push   # skip `brew audit`: it insists on formula_opt_bin, which older Homebrew lacks
```
Keep `packaging/agent-router.rb` in this repo identical to the tap's formula. Use `Formula["node"].opt_bin`
(works on old Homebrew); `formula_opt_bin` is newer and breaks users who haven't run `brew update`.

## What users run
- Homebrew: `brew update && brew upgrade agent-router && brew services restart agent-router`
- Source: `git pull && ./agent-router.sh restart`

## Before tagging
- Ledger migrations are add-column-if-missing: never rename or drop a column in a patch release.
- Anything under `~/.agent-router/` (ledger, certs, accounts) must survive the upgrade untouched.
- If `ui.html` changed, it is served `cache-control: no-store`, so no version bump is needed for the browser.
- Restart the live router on your own machine first (`./agent-router.sh restart`, then `status`).
