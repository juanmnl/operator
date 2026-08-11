#!/usr/bin/env python3
# Capture the RAW pty byte stream of a real Claude Code FULLSCREEN (alt-screen) session.
#
# Sibling of capture-claude.py, which captures classic tui. The difference matters: every
# other harness fixture in this directory is `{"tui":"default"}`, so nothing exercised the
# alt-screen path, which is exactly where the composer ghost lives. A fullscreen stream is
# absolute-positioned (CUP) redraws of a fixed viewport rather than a scrolling log, so the
# bottom rows — the composer and the rule/status lines around it — are rewritten in place on
# every frame.
#
# The output is COMMITTED (claude-fullscreen.bin) so verify:ghost is reproducible without a
# live Claude session or an API key. Re-run this only to refresh the fixture.
import os, pty, sys, select, struct, fcntl, termios, time

# `python3 capture-claude-fullscreen.py [name] [deadline] [prompt]`. Two fixtures are committed:
# claude-fullscreen (a short turn) and claude-fullscreen-long (a multi-turn session with many more
# redraw cycles) — one capture is not a sample, and the harness runs every scenario against both.
COLS, ROWS = 120, 30
NAME = sys.argv[1] if len(sys.argv) > 1 else "claude-fullscreen"
DEADLINE = int(sys.argv[2]) if len(sys.argv) > 2 else 45  # seconds hard cap
PROMPT = (sys.argv[3] if len(sys.argv) > 3 else "Count from 1 to 5, one number per line. Do not use any tools.").encode() + b"\r"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), f"{NAME}.bin")

pid, fd = pty.fork()
if pid == 0:
    # Child: become claude in FULLSCREEN tui, same settings Operator spawns a lane with.
    os.execvp("claude", ["claude", "--settings", '{"tui":"fullscreen"}'])
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
raw = bytearray()
start = time.time()
sent = False
try:
    while True:
        if time.time() - start > DEADLINE:
            break
        r, _, _ = select.select([fd], [], [], 0.5)
        if fd in r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            raw += chunk
        if not sent and time.time() - start > 4.0:
            os.write(fd, PROMPT)
            sent = True
        if sent and time.time() - start > DEADLINE - 12:
            os.write(fd, b"\x03")
            time.sleep(0.5)
            os.write(fd, b"\x04")
            time.sleep(0.5)
            r, _, _ = select.select([fd], [], [], 1.0)
            if fd in r:
                try: raw += os.read(fd, 65536)
                except OSError: pass
            break
finally:
    try: os.close(fd)
    except OSError: pass

with open(OUT, "wb") as f:
    f.write(raw)

# Assert this really is alt-screen. A capture that silently fell back to classic tui would
# make the whole harness test the wrong thing — the failure mode feedback_fixtures_must_match
# _reality is about.
alt_enter = b"\x1b[?1049h" in raw
cup = b"\x1b[30;1H" in raw or b"\x1b[29;1H" in raw
print(f"captured {len(raw)} bytes -> {OUT}")
print(f"  alt-screen enter (ESC[?1049h): {alt_enter}")
print(f"  absolute CUP to bottom rows:   {cup}")
if not alt_enter:
    print("  !! NOT a fullscreen capture - do not commit this fixture", file=sys.stderr)
    sys.exit(1)
