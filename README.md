# Checklist Timer

Times how long each item in a checklist takes, so you can see which steps
in a recurring process — a weekly review, a deploy checklist, any process
you run more than once — are actually eating the time.

It's not a Pomodoro timer, and it's not an invoicing/billable-hours tool.
It's a process-insight tool for repeatable checklists.

## How it works

Mark a checklist as timed with a tag on its own line directly above the
list (default `#Timed`, configurable in settings — matched
case-insensitively, so `#timed` works too):

```
#Timed
- [ ] Start week plan
- [ ] Review calendar
- [ ] Draft priorities
- [ ] Send updates
```

Checking off the first item starts the clock. Each time you check off the
next item, the time since the previous check-off is recorded against it,
and timing continues automatically through the rest of the list.

Want a different item to be the starting point instead of the first one?
Tag it with `#Start` (also configurable) anywhere in the list — items
before it are simply not timed:

```
#Timed
- [ ] Gather notes (not timed)
- [ ] #Start Kickoff
- [ ] Next step
```

A session ends when the last item is checked off, or you stop it manually
via the ribbon icon or the "Stop active timer" command. The timing note is
written incrementally as you go, so even an abandoned checklist keeps
whatever was already timed. When a session ends, a summary sorted by
duration (slowest first) is appended so the bottleneck is easy to spot.

Only one checklist can be timed at a time. If you start a second one while
another is running, by default the first is stopped automatically (saving
what it had timed) and the second starts — this is configurable.

## Settings

- **Timed checklist tag** — marks a checklist as timed (default `#Timed`, matched case-insensitively).
- **Start item tag** — marks the start item within a timed checklist (default `#Start`, matched case-insensitively).
- **Auto-switch between checklists** — automatically stop-and-switch when a second timed checklist is started while one is running, instead of blocking it (default on).
- **Output folder** — where timing notes are saved (default: vault root).
- **Filename template** — supports `{{date}}` and `{{title}}` placeholders.

## Example output

```
# Checklist timing — Week Plan

- Review calendar: 00:02:14
- Draft priorities: 00:08:41
- Send updates: 00:01:03

Total: 00:11:58

## Sorted by duration (slowest first)

- Draft priorities: 00:08:41
- Review calendar: 00:02:14
- Send updates: 00:01:03
```

## Scope

Desktop only. Nested/indented checklist items aren't rolled up into their
parent's time yet. There's no session persistence — if Obsidian closes or
crashes mid-session, the in-progress timer is lost, but anything already
timed and written to the note is safe.

## Installation

Available from Obsidian's Community Plugins:

1. Settings → Community plugins → Browse.
2. Search for "Checklist Timer".
3. Install, then enable it.

To manually install a specific release instead (e.g. to try a version
before it's landed in Community Plugins):

1. Download `main.js` and `manifest.json` from the desired release at
   https://github.com/AnandSie/obsidian_plugin_checklist_timer/releases
2. Create a folder named `checklist-timer` inside `<YourVault>/.obsidian/plugins/`.
3. Copy both files into that folder.
4. Reload Obsidian and enable **Checklist Timer** under Settings → Community plugins.

## Development

```
npm install
npm run dev    # rebuilds on change
npm test       # unit tests
npm run build  # production build
```
