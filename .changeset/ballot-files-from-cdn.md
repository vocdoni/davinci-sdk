---
'@vocdoni/davinci-sdk': minor
---

The ballot circuit files download from the DAVINCI CDN first (`https://davinci-assets.fra1.cdn.digitaloceanspaces.com/ballot/<davinci-circom commit>/<file>`), and from raw GitHub at the pinned davinci-circom commit when the CDN cannot serve a copy with the pinned sha256. Every copy is checked against the same sha256 and verification key hash as before. `ArtifactFile.mirrors` lists the fallback URLs of a table entry, tried in order, and a load that fails names every source it tried. An `artifacts` override (`baseUrl`, `dir` or a per-file source) is still the only source of its files.

A browser app with a Content-Security-Policy must allow `https://davinci-assets.fra1.cdn.digitaloceanspaces.com` in `connect-src`, next to `https://raw.githubusercontent.com`.
