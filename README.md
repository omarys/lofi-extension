# Lofi Stream

A GNOME Shell extension that puts one lofi stream in the top panel, played
through `mpv` and controlled over mpv's JSON IPC socket.

It exists separately from the pomodoro timer so the player has one owner: the
stream keeps running (or stays paused, ready to resume) while the timer starts
and stops focus phases, and disabling either extension cannot orphan the other.

## Requirements

- GNOME Shell 45–51
- `mpv` and `yt-dlp` — mpv uses yt-dlp to resolve YouTube URLs
- [mise](https://mise.jdx.dev) for the dev toolchain (`node`, `pre-commit`)
- `gjs` and `glib-compile-schemas` to build and test

`mise run deps` reports which of these are missing.

## Install

```sh
mise trust            # once, so mise may run this repo's tasks
mise run install
gnome-extensions enable lofi@omary.local
```

Shell only notices a newly installed extension in a fresh session, so log out
and back in (Wayland) before enabling.

## Use

The panel icon is the whole interface:

- left click — start the stream, or stop it and close mpv
- right click — the menu: stream switch, preferences, about

Stopping tears mpv down rather than pausing it, so a manual off actually frees
the process. A stray mpv left behind by a crashed shell is killed too, because
`Stop` uses the same `reset()` path.

## Other extensions

The stream is on the session bus, so any caller can drive it — the pomodoro
timer starts it with a focus phase and pauses it on a break:

```sh
gdbus call --session -d org.omary.Lofi -o /org/omary/Lofi \
  -m org.omary.Lofi.Toggle
```

| method | in | out |
| --- | --- | --- |
| `Play` | `s` url — empty means the configured stream | `b` started |
| `Pause` | — | `b` paused |
| `Stop` | — | `b` stopped |
| `Toggle` | — | `b` playing |
| `GetState` | — | `s` `playing` / `paused` / `off` |

The interface is a contract: keep it additive, so a caller written against
`Play`/`Pause`/`Stop`/`Toggle`/`GetState` keeps working.

## Tests

```sh
mise tasks            # every available task
mise run check        # schema + syntax + service tests
```

`tests/service-dbus.js` drives the service with a fake player, so most of it
needs no mpv and no display. When a session bus is present it also does a real
round trip through `org.omary.Lofi`, which is the part that catches a signature
mismatch before the timer hits it.

Git hooks are optional:

```sh
pre-commit install    # runs `mise run check` before every commit
```
