#!/usr/bin/env python3
"""One-shot driver: run `eas build` under a PTY using Apple ID (cookie) auth so
EAS can create/link the App Group capability. Auto-sends the Apple ID password
from the APPLE_ID_PASSWORD secret; relays anything written to /tmp/eas_in
(e.g. the 2FA code) into the child. Logs everything to /tmp/eas_interactive.log.
"""
import os
import pty
import select
import time

LOG = "/tmp/eas_interactive.log"
INFIFO = "/tmp/eas_in"
WORKDIR = "/home/runner/workspace/artifacts/labtrax"

try:
    os.mkfifo(INFIFO)
except FileExistsError:
    pass

env = os.environ.copy()
env["EAS_NO_VCS"] = "1"
env["FASTLANE_PASSWORD"] = env.get("APPLE_ID_PASSWORD", "")
env.pop("CI", None)
for k in [
    "EXPO_ASC_API_KEY_PATH", "EXPO_ASC_KEY_ID", "EXPO_ASC_ISSUER_ID",
    "EXPO_ASC_API_KEY_ID", "EXPO_ASC_API_KEY_ISSUER_ID",
]:
    env.pop(k, None)

pid, master = pty.fork()
if pid == 0:
    os.chdir(WORKDIR)
    os.execvpe("pnpm", ["pnpm", "exec", "eas", "build", "--platform", "ios",
                        "--profile", "production"], env)
    os._exit(127)

logf = open(LOG, "ab", buffering=0)
infd = os.open(INFIFO, os.O_RDONLY | os.O_NONBLOCK)
inwr = os.open(INFIFO, os.O_WRONLY | os.O_NONBLOCK)  # keep writer end open

pw = env.get("FASTLANE_PASSWORD", "")
sent_pw = False
sent_login_yes = False
buf = b""

while True:
    try:
        r, _, _ = select.select([master, infd], [], [], 1.0)
    except OSError:
        break
    if master in r:
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        logf.write(data)
        buf += data
        tail = buf[-400:].decode("utf-8", "ignore").lower()
        if (not sent_login_yes) and "log in to your apple account" in tail:
            time.sleep(0.3)
            os.write(master, b"y\n")
            sent_login_yes = True
            logf.write(b"\n<<driver: answered apple-login y>>\n")
        if (not sent_pw) and pw and "password" in tail and (
            "apple" in tail or "enter your" in tail or "password:" in tail
        ):
            time.sleep(0.3)
            os.write(master, (pw + "\n").encode())
            sent_pw = True
            logf.write(b"\n<<driver: sent password>>\n")
    if infd in r:
        try:
            d = os.read(infd, 4096)
            if d:
                os.write(master, d)
                logf.write(b"\n<<driver: forwarded input>>\n")
        except OSError:
            pass
    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            try:
                while True:
                    data = os.read(master, 4096)
                    if not data:
                        break
                    logf.write(data)
            except OSError:
                pass
            break
    except ChildProcessError:
        break

logf.close()
