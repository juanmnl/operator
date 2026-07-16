#!/usr/bin/env python3
# Capture the RAW pty byte stream of a real Claude Code classic-tui session, so we
# can replay the exact bytes through the headless production xterm and see whether
# xterm's BUFFER garbles (parse/width drift → fixable) or stays clean (→ the garble
# is WKWebView-specific compositing, a different fix). Runs one tiny prompt.
import os, pty, sys, select, struct, fcntl, termios, time

COLS, ROWS = 120, 30
PROMPT = b"Reply with exactly: DONE. Do not use any tools.\r"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "claude-stream.bin")
DEADLINE = 40  # seconds hard cap

pid, fd = pty.fork()
if pid == 0:
    # Child: become claude in classic tui, same settings Operator spawns with.
    os.execvp("claude", ["claude", "--settings", '{"tui":"default"}'])
    os._exit(127)

# Parent: set the window size, drive the prompt, record everything claude emits.
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
        # Send the prompt once the TUI has had a moment to paint.
        if not sent and time.time() - start > 3.0:
            os.write(fd, PROMPT)
            sent = True
        # Once we've seen the model reply + a spinner cycle, give it a bit then quit.
        if sent and time.time() - start > 30 and b"DONE" in raw:
            os.write(fd, b"\x03")  # Ctrl-C
            time.sleep(0.5)
            os.write(fd, b"\x04")  # Ctrl-D
            time.sleep(0.5)
            # drain
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
print(f"captured {len(raw)} bytes → {OUT}")
