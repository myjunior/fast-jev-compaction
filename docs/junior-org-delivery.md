# Delivering fast-jev-compaction through Junior's managed settings

Since Claude Code 2.1.299, on Team and Enterprise organizations the built-in
`cc-plugin-sec-default` plugin passes `session.compact` over every plugin a
person installs, so a user-installed copy of this plugin never compacts. A
plugin the organization delivers through managed settings sits in the
`append` tier, which sec-default hands the event to, so it runs.

## Managed settings

Add these keys to the organization's Claude Code managed settings (claude.ai
admin console), alongside the settings already there:

```json
{
  "extraKnownMarketplaces": {
    "junior-fast-jev": {
      "source": { "source": "github", "repo": "myjunior/fast-jev-compaction" },
      "pluginDigests": { "fast-jev-compaction": ["<digest>"] }
    }
  },
  "enabledPlugins": { "fast-jev-compaction@junior-fast-jev": true },
  "appendPlugins": ["fast-jev-compaction@junior-fast-jev"]
}
```

Use `appendPlugins`, never `prependPlugins`: once `prependPlugins` is set,
sec-default only runs if it is listed there, which would drop its protection
for every plugin people install.

## Releasing a new version

Claude Code loads the plugin only from a folder whose digest is listed, so
every change to `plugin/` needs a new digest in managed settings.

1. Merge the change to `main`.
2. From a clean checkout of `main`, run `bun scripts/plugin-digest.ts plugin`.
3. Add the new digest to the `pluginDigests` list (keep the old one until
   everyone has updated), then remove the old one.

`plugin/` must never hold a `package.json`: Claude Code would install
dependencies into the copy, which changes the digest per machine. If the
digest check fails, `claude --debug-file <file>` logs the folder's actual
digest ("its folder's digest is …, not one listed").

## Who it affects

The managed setting enables the plugin for every member. It does nothing
unless the person has a TypeSafe key (`TYPESAFE_API_KEY` in their
environment or `settings.json` `env`, or the plugin's `apiKey` option). With a
key, the conversation is sent to TypeSafe's Jev API at compaction time.
