---
name: kiln-skills
description: Inspect and repair kiln's shared user or project skills, including missing links and conflicting Claude or Pi copies.
---

# Manage shared skills with kiln

Use `kiln skills list` for user/machine scope, or
`kiln skills list --project /absolute/project` for project scope. The JSON includes
the canonical store, Claude/Pi adapter directories and each skill's state.
Codex reads `.agents/skills` directly. Claude and Pi use compatibility links.

- `shared`: the adapter resolves to the canonical skill.
- `missing`: no adapter exists. `kiln skills share NAME` creates the missing links.
- `conflict`: another file, directory or broken link occupies the adapter name.

For a conflict, inspect the canonical `SKILL.md` and the clashing adapter before
choosing which content to retain. The shared store is the source used by kiln's
repair action. If the user wants that version, run
`kiln skills share NAME --backup-conflicts`; add `--project /absolute/project`
for project scope. This preserves conflicting entries under the shared store's
`.kiln-backups` directory before replacing them with links. Report the backup
paths. Supporting files remain intact. To restore, unlink only kiln's adapter
link and move the backup to its original adapter path.

If the adapter contains changes the user wants, merge them into the canonical
skill before repairing. Keep unrelated skills and harness configuration intact.
Do not treat a same-name directory as disposable. Re-list after repairs and
reload skills in existing harness sessions.

In kiln, `S` opens skills, `u` selects user scope, `p` selects project scope,
`l` shares missing links, and `f` repairs the selected skill after confirmation.
`Enter` edits, `i` copies an existing skill, and `x` removes only kiln's links.

`kiln skills sync` refreshes the bundled kiln skills. Kiln also syncs them when
opening its TUI. Managed edits are backed up before an update; unrelated skills
with the same name are preserved and reported as conflicts.
