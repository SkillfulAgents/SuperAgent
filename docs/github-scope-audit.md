# GitHub sufficient-scope audit

Audited all 301 existing GitHub mappings on 2026-10-21. The corrected map has
300 entries: 251 existing entries gain sufficient alternatives, two paths are
corrected (with an additional no-ref variant), and two invalid entries are removed.
The catalog declares 46 new fine-grained permission keys with descriptions and
risk labels. The matcher and the approval UI's minimum-risk selection are unchanged.

## Sources and method

- [GitHub App permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [Fine-grained PAT permission table](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
- [Classic OAuth scopes and inheritance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- Machine-readable App table: `github/docs`,
  `src/github-apps/data/fpt-2026-03-10/server-to-server-permissions.json`,
  blob SHA `a49e26d5a777d8680bb2d33c24596297083b1e9f`.

Join the existing mappings to the tables by HTTP verb and normalized path
parameters. Review every unmatched row and every `additional-permissions` row
against the individual endpoint documentation. That flag covers both **OR**
alternatives and **AND** requirements; it cannot be copied into a flat list blindly.

`sufficientScopes` is an OR-list of independently sufficient policy keys, not a
list of permissions to request from OAuth. Fine-grained keys use GitHub's machine
permission name plus `:read` or `:write`; classic scopes keep their existing names.
Write access also suffices for reads of that permission. Only include a write
variant when GitHub actually defines it (Metadata, for example, is read-only).
These are local approval policies; the connected credential still determines
which resources GitHub permits the request to access.

## Changes

Add fine-grained alternatives for Checks, Actions, repository metadata, contents,
issues, pull requests, deployments, commit statuses, administration, webhooks,
secrets, code/secret scanning, organization membership, repository creation and
invitations, profile updates, email, followers, gists, signing/authentication keys,
and starred repositories.

Preserve independent alternatives across permission families: issue comments,
labels, milestones and related operations accept Issues **or** Pull requests;
getting a PR accepts Contents **or** Pull requests; repository creation accepts
Administration **or** Repository creation; listing repository invitations accepts
Administration **or** Private repository invitations. Merging a PR requires
Contents write, not Pull requests write.

Expand classic scope inheritance: organization read/write/admin, repository
webhook read/write/admin, SSH/GPG/signing key read/write/admin, project read/write,
user profile/email/follow permissions, and repository status/deployment/invitation
permissions. Include the explicitly documented `repo` alternative for
notifications and team repository listing, `user`/`repo` for the authenticated
user's teams, `read:org` for organization membership lookup, and `read:repo_hook`
for pinging a repository webhook.

Correct compare requests to `/repos/{owner}/{repo}/compare/{base}...{head}` and
reference listing to `/repos/{owner}/{repo}/git/matching-refs/{ref}` (including
omitted `ref`). Remove the nonexistent issue-assignees GET and workflow-dispatch
PUT entries; the documented dispatch POST is retained with Actions write.

## Combinations and exceptions

The current flat policy model cannot express required combinations. Preserve the
existing classic alternatives for these operations rather than treating one
part of a combination as sufficient:

| Operation | Fine-grained requirement | Source |
| --- | --- | --- |
| Create a fork | Contents read **and** either Administration write or Repository creation write | [Forks](https://docs.github.com/en/rest/repos/forks#create-a-fork) |
| Add/remove a team repository | Administration write **and** Members read (the docs also require Metadata read) | [Teams](https://docs.github.com/en/rest/teams/teams#add-or-update-team-repository-permissions) |
| Star/unstar a repository | Starring write **and** Metadata read | [Starring](https://docs.github.com/en/rest/activity/starring#star-a-repository-for-the-authenticated-user) |

For content, reference and release writes, the documented alternatives include
Contents write alone or Contents write **and** Workflows write. Include Contents
write, never Workflows write by itself. Workflow-specific requirements remain
enforced by GitHub; this audit does not introduce request-body permission rules.

The [stargazers endpoint](https://docs.github.com/en/rest/activity/starring#list-stargazers)
documents Metadata read **or** Contents write, even though the App table only
lists the latter. Include both.

Retain the legacy mappings where the tables and endpoint documentation do not
establish another independently sufficient permission: retired Projects classic,
notifications/watching, release-asset upload, and public/user/search/gist reads
without a declared fine-grained permission. Do not invent a `gists:read` scope or
infer private-data access from an endpoint's unauthenticated public-data behavior.
This audit does not broaden the existing `github.public` policies or change the
matcher to model resource visibility, token types, or combined permissions.

## Regression coverage

`scope-maps-github.test.ts` exercises real matcher paths across permission
families, classic inheritance, independent alternatives, conjunction exclusions,
mutation boundaries, and corrected paths. `scope-metadata.test.ts` checks complete
scope descriptions and labels. The approval component regression uses the reported
check-runs request and verifies that it offers and persists the Read group despite
the broad `repo` alternative.
