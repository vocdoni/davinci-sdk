# Changesets

Each pull request with a user-visible change adds a changeset here: a Markdown
file that names the release type and describes the change for the changelog.
Create one with `yarn changeset`, or write it by hand:

```md
---
'@vocdoni/davinci-sdk': minor
---

Add `sdk.foo()`, which …
```

On `main`, the release workflow collects the changesets into a "Version
Packages" pull request that bumps the version and writes `CHANGELOG.md`.
Merging it publishes the release. See [CONTRIBUTING.md](../CONTRIBUTING.md#changesets-and-releases).
