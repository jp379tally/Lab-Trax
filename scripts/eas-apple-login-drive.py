#!/usr/bin/env python3
"""Run `eas build` under a PTY using Apple ID (cookie) auth so EAS can
create/link the App Group capability on the App IDs.

Designed to run as a persistent Replit *workflow* (survives across agent turns).
Auto-handles: Apple-login confirm (y), Apple ID password (from APPLE_ID_PASSWORD),
and the 2FA delivery-method select (defaults to "device"). The only human step is
the 6-digit code: write it to /tmp/eas_2fa_code (e.g. `echo 123456 > /tmp/eas_2fa_code`)
and the driver feeds it in. An escape hatch for any unexpected prompt: write raw
text (with newline) to /tmp/eas_input. All child output is mirrored to
/tmp/eas_interactive.log.
"""
import os
import pty
import select
import time

LOG = "/tmp/eas_interactive.log"
CODEFILE = "/tmp/eas_2fa_code"
MANUAL = "/tmp/eas_input"
WORKDIR = "/home/runner/workspace/artifacts/labtrax"

for f in (CODEFILE, MANUAL):
    try:
        os.remove(f)
    except FileNotFoundError:
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

logf = open(LOG, "wb", buffering=0)
pw = env.get("FASTLANE_PASSWORD", "")
sent_login = False
sent_pw = False
sent_method = False
sent_phone = False
sent_code = False
buf = b""


def drain_once():
    try:
        rr, _, _ = select.select([master], [], [], 0.0)
        if master in rr:
            d = os.read(master, 4096)
            if d:
                logf.write(d)
    except OSError:
        pass


while True:
    # manual escape hatch for any unexpected prompt
    if os.path.exists(MANUAL):
        try:
            with open(MANUAL) as f:
                m = f.read()
            os.remove(MANUAL)
            if m:
                os.write(master, m.encode())
                logf.write(b"\n<<driver: manual input>>\n")
        except OSError:
            pass

    try:
        r, _, _ = select.select([master], [], [], 1.0)
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
        buf = (buf + data)[-4000:]
        tail = buf[-600:].decode("utf-8", "ignore").lower()

        if (not sent_login) and "log in to your apple account" in tail:
            time.sleep(0.3)
            os.write(master, b"y\n")
            sent_login = True
            logf.write(b"\n<<driver: login y>>\n")
        elif (not sent_pw) and pw and ("password (for" in tail or
                                       "enter your apple" in tail):
            time.sleep(0.3)
            os.write(master, (pw + "\n").encode())
            sent_pw = True
            logf.write(b"\n<<driver: sent password>>\n")
        elif (not sent_method) and "how do you want to validate your account" in tail:
            time.sleep(0.6)
            os.write(master, b"\x1b[B")  # arrow down -> select "sms"
            time.sleep(0.7)
            os.write(master, b"\r")
            sent_method = True
            logf.write(b"\n<<driver: method=sms>>\n")
        elif (not sent_phone) and ("trusted phone number" in tail or
                                   "select a phone" in tail or
                                   "phone number to use" in tail or
                                   "which phone number" in tail):
            time.sleep(0.5)
            os.write(master, b"\r")
            sent_phone = True
            logf.write(b"\n<<driver: phone select default>>\n")
        elif (not sent_code) and "enter the" in tail and "code" in tail:
            logf.write(b"\n<<driver: awaiting 2FA code at /tmp/eas_2fa_code>>\n")
            code = None
            for _ in range(900):  # up to ~15 min
                if os.path.exists(CODEFILE):
                    try:
                        with open(CODEFILE) as f:
                            code = f.read().strip()
                    except OSError:
                        code = None
                    try:
                        os.remove(CODEFILE)
                    except OSError:
                        pass
                    if code:
                        break
                drain_once()
                time.sleep(1.0)
            if code:
                os.write(master, (code + "\n").encode())
                sent_code = True
                logf.write(b"\n<<driver: sent 2FA code>>\n")
            else:
                logf.write(b"\n<<driver: TIMEOUT waiting for 2FA code>>\n")

    try:
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            try:
                while True:
                    d = os.read(master, 4096)
                    if not d:
                        break
                    logf.write(d)
            except OSError:
                pass
            break
    except ChildProcessError:
        break

logf.close()
