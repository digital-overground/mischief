# Issue tracker: Linear

Issues and specs live in Linear workspace `digital-overground`, team `MIS`. Use the `linear` CLI from this repository; `.linear.toml` supplies the workspace and team defaults.

GitHub remains the source and pull-request host. Do not create GitHub issues for Mischief work.

## Authentication

Use the stored Linear CLI credential selected by `.linear.toml`. `LINEAR_API_KEY` overrides repository workspace selection, so unset it before working in this repository.

## Conventions

- Query team issues: `linear issue query --team MIS --limit all --json`
- Read an issue and its comments: `linear issue view MIS-123 --json`
- Create an issue: `linear issue create --team MIS --title "Title" --description-file <file> --state Backlog --no-input`
- Update an issue: `linear issue update MIS-123 --state "In Progress"`
- Add or remove labels: `linear issue update MIS-123 --add-label ready-for-agent` or `linear issue update MIS-123 --remove-label needs-info`
- Comment: `linear issue comment add MIS-123 --body-file <file>`
- Close: `linear issue update MIS-123 --state Done`
- Assign: `linear issue update MIS-123 --assignee @me`

Use `issue query`, not `issue list`, when inspecting team work; `issue list` defaults to the current user's issues.

Use `--description-file` and `--body-file` for multiline Markdown.

## Parent issues and dependencies

- Create a child issue with `linear issue create --parent MIS-123 ...`.
- Reparent an existing issue with `linear issue update MIS-124 --parent MIS-123`.
- Record blocking relationships with `linear issue relation add MIS-124 blocked-by MIS-123`.
- Inspect a parent and its children with `linear issue view MIS-123 --json`.

## Skill translations

When a skill says:

- **publish to the issue tracker**: create a Linear issue in team `MIS`;
- **fetch the relevant ticket**: run `linear issue view <identifier> --json`;
- **claim a ticket**: assign it to `@me` and move it to `In Progress`;
- **resolve a ticket**: add the result as a comment, then move it to `Done`.
