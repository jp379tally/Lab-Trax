import pexpect
import sys
import os

os.chdir("/home/runner/workspace/artifacts/labtrax")

env = os.environ.copy()
env["EAS_NO_VCS"] = "1"
env["EAS_BUILD_NO_EXPO_GO_WARNING"] = "true"

child = pexpect.spawn(
    "eas credentials --platform ios",
    env=env,
    timeout=60,
    encoding="utf-8",
    codec_errors="ignore",
)
child.logfile = sys.stdout

try:
    # Select build profile — navigate to "production" (3rd option)
    child.expect(r"build profile")
    child.send("\033[B")  # down to preview
    child.send("\033[B")  # down to production
    child.send("\r")

    # May ask for ASC API Key ID
    idx = child.expect([r"ASC Api Key ID", r"What do you want to do", r"Set up new", pexpect.TIMEOUT], timeout=20)
    if idx == 0:
        child.sendline("RV23AJ8V62")
        child.expect(r"Issuer ID")
        child.sendline("1d2faabc-3d66-4e64-b514-c234043e143a")
        child.expect(r"[Pp]ath")
        child.sendline("/tmp/AuthKey_RV23AJ8V62.p8")

    # Accept all remaining prompts with Enter
    while True:
        idx = child.expect([r"\?", r"✔", r"Error", pexpect.EOF, pexpect.TIMEOUT], timeout=30)
        if idx == 0:
            child.sendline("")
        elif idx == 1:
            continue
        elif idx == 2:
            print("\n[ERROR in credential setup]")
            break
        else:
            break

except pexpect.EOF:
    pass
except Exception as e:
    print(f"\n[Exception: {e}]")

child.close()
print(f"\n[Exit status: {child.exitstatus}]")
