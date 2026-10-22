---
title: "Fix the dead links in index.html and wire up /tv/"
created: 2026-10-05T11:57:33+03:00
status: executing
model: "opencode/big-pickle"
session: "smuuy08mqq938"
steps: 6
files:
  - "index.html"
  - "tv/.git"
  - "tv/index.html"
  - "tv/playlist.m3u"
  - "tv/LICENSE"
  - "live.html"
---

# Fix the dead links in index.html and wire up /tv/

> **Request** — fix the broken links in index.html

## Reading

The download/app links in the local index.html point at files that no longer exist, so I should repoint them at verified-working targets (GitHub release assets and the local /gabay/ and /tv/ folders) so every button on the page actually resolves.

## Decisions

- **This folder's remote is `BCAprogrammer/barkhad_website` and local HEAD is 9 commits behind origin/main. The live barkhad.top is served from origin/main, whose index.html has a CCTV Viewer card and a feedback form that your local file does not. Which file should I fix?** — Fix the local working-copy index.html (the one open in your editor)
- **Gabay's card points at `Assets/apks/gabay.apk`, which no longer exists (deleted in commit 688bf0b, live 404). What should it point to?** — Both: APK download + a second "Open Web App" button
- **The TV card links to `/tv/`, but the local `tv/` folder is untracked (its own repo, BCAprogrammer/tv) and barkhad.top/tv/ returns 404. How should I resolve it?** — Commit the untracked `tv/` folder into this repo so `/tv/` works on your own domain

## Steps

- [ ] Point Gabay's APK button at the GitHub release asset instead of the deleted local file
  - Files: `index.html`
  - Evidence: index.html:599 points at `Assets/apks/gabay.apk`, which was deleted in commit 688bf0b; `curl https://barkhad.top/Assets/apks/gabay.apk` returns 404 while `https://github.com/BCAprogrammer/barkhad_website/releases/download/gabay_ccod/gabay_cod.apk` returns 200. A local path cannot work here anyway — `.gitignore:16` (`*.apk`) ignores every file in Assets/apks, and only sharci.apk is force-tracked.
  - Verify: grep index.html for the old `Assets/apks/gabay.apk` — zero hits; curl -L the new URL and expect 200
- [ ] Add an "Open Web App" button next to Gabay's APK download
  - Files: `index.html`
  - Evidence: index.html:598-601 is a single-button `.btn-row`; `curl https://barkhad.top/gabay/` returns 200 and the `gabay/` Flutter build is tracked in this repo, so the web app is a working second target for the same card.
  - Verify: grep index.html for `/gabay/` inside the Gabay `.btn-row`
- [ ] Remove the nested `tv/.git` so the TV player can be committed into this repo
  - Files: `tv/.git`
  - Evidence: `git add -n tv` prints "warning: adding embedded git repository: tv" — git would record a broken gitlink instead of the files, so clones of this repo would get an empty tv/. The tv history is safe: its origin is `https://github.com/BCAprogrammer/tv.git` and `git log` inside tv/ shows all commits pushed there.
  - Verify: `Test-Path tv\.git` returns False; `git status --porcelain` shows `?? tv/index.html`, `?? tv/playlist.m3u`, `?? tv/LICENSE` instead of `?? tv/`
- [ ] Serve the playlist from the committed local file, falling back to the remote one
  - Files: `tv/index.html`
  - Evidence: tv/index.html:551 lists only the remote `https://raw.githubusercontent.com/bcaprogrammer/tv/main/playlist.m3u`, so /tv/ depends on a CDN file rather than the playlist.m3u that is about to be committed alongside it.
  - Verify: grep tv/index.html for a local `'playlist.m3u'` entry appearing before the raw.githubusercontent URL
- [ ] Commit tv/ and push so /tv/ resolves on barkhad.top
  - Files: `tv/index.html`, `tv/playlist.m3u`, `tv/LICENSE`
  - Evidence: `git ls-files tv` returns nothing and `git status --porcelain` shows `?? tv/`; `.github/workflows/static.yml:40` uploads path `.`, so once tracked, /tv/ publishes automatically — that is what makes `index.html:574`'s `href="/tv/"` valid on your own domain.
  - Verify: git ls-files tv lists all three files; after the Pages run, curl https://barkhad.top/tv/ returns 200
- [ ] Delete the live.html scratch file I downloaded while checking link status
  - Files: `live.html`
  - Evidence: `git status --porcelain` lists `?? live.html` — a copy of the live index.html fetched with curl during this investigation, not part of your site.
  - Verify: git status --porcelain no longer lists live.html
