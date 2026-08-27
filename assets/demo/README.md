# Demo GIF

`demo.gif` is rendered from `demo.tape` with [VHS](https://github.com/charmbracelet/vhs),
so it can be regenerated instead of re-recorded by hand:

```bash
vhs demo.tape
```

VHS needs `ttyd`, `ffmpeg` and a Chrome/Chromium binary on `PATH`.

`trail.mjs` replays the exchange documented in
[`docs/example-debate.md`](../../docs/example-debate.md) with the pacing of a live
session. The words and the command output are that exchange's; the timing is
scripted so the whole thing fits in a readable twenty seconds.
