import os
import base64
import re
import subprocess
import tempfile
from pathlib import Path


def write_key(raw, destination=Path("/tmp/AuthKey_RV23AJ8V62.p8")):
    """Validate before replacing; never emit credential contents in an error."""
    raw = raw.replace("\\n", "\n").strip()
    match = re.fullmatch(
        r"-----BEGIN PRIVATE KEY-----\s*([A-Za-z0-9+/=\s]+)"
        r"\s*-----END PRIVATE KEY-----", raw,
    )
    if not match:
        raise ValueError("ASC_API_KEY_P8 is missing or is not a PKCS#8 PEM key.")
    body = re.sub(r"\s+", "", match.group(1))
    try:
        decoded = base64.b64decode(body, validate=True)
    except ValueError:
        raise ValueError("ASC_API_KEY_P8 contains invalid base64.") from None
    if not decoded:
        raise ValueError("ASC_API_KEY_P8 contains an empty key.")
    pem = "-----BEGIN PRIVATE KEY-----\n"
    pem += "\n".join(body[i:i + 64] for i in range(0, len(body), 64))
    pem += "\n-----END PRIVATE KEY-----\n"
    checked = subprocess.run(
        ["openssl", "pkey", "-check", "-noout"],
        input=pem.encode(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if checked.returncode:
        raise ValueError("ASC_API_KEY_P8 is not a valid private key.")
    public = subprocess.run(
        ["openssl", "pkey", "-pubout", "-outform", "DER"],
        input=pem.encode(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    # ES256 requires EC P-256, not just any syntactically valid PKCS#8 key.
    # This is the standard SubjectPublicKeyInfo prefix (EC + prime256v1).
    p256_prefix = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d03010703420004")
    if public.returncode or not public.stdout.startswith(p256_prefix):
        raise ValueError("ASC_API_KEY_P8 must be an EC P-256 key for ES256.")
    # mkstemp creates mode 0600. Atomic replacement also avoids following an
    # existing symlink or leaving a truncated key after an interrupted write.
    fd, temporary = tempfile.mkstemp(prefix=".asc-key-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(pem)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    try:
        write_key(os.environ.get("ASC_API_KEY_P8", ""))
    except (ValueError, OSError):
        raise SystemExit("ASC key preparation failed: check the saved PKCS#8 key and OpenSSL availability.")
    print("ASC key prepared (owner-only permissions).")
