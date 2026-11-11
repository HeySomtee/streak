# Dedicated Streak repository

11 November 2026. Source: [HeySomtee/ckbuilder](https://github.com/HeySomtee/ckbuilder)
at `a1b2346ea68b6eab951cdacfab6c2bc4212c76a4`.

The extraction retains 89 commits relevant to Streak, its contract foundations,
shared delivery tooling and public reports. Authors and original commit dates
are retained. Filtered commits have new IDs; the [commit map](migration-commit-map.tsv)
links them back to the original repository. Unrelated learning exercises and
private DM files are excluded, including historical versions of those files.

The app remains at `products/streak` because the shared contract client, local
chain tests and deployment configuration depend on those paths. No deployed
script, runtime payment rule, registry or database is migrated by this Git change.

## Local work and hosting

The committed baseline is published independently of the uncommitted v5
sign-once queue. That work is carried to the new local checkout as uncommitted
files, with the owner's local acceptance checklist kept local as well. Private
environment files, keys, operator state and correspondence are not published.

The old repository remains available. GitHub issues, pull requests, stars,
secrets and deployment settings are not Git history and are not copied by this
extraction. Existing grant-issue links still point to their original location.

Render continues using its existing repository until its service setting is
deliberately changed. Reuse the existing service, disk, database and environment
when switching its repository to `HeySomtee/streak`; do not create a second signer
or a new empty database. Build/start paths remain those in [render.yaml](../render.yaml).
Hosted CI remains paused.
