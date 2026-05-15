import os

raw = os.environ.get("ASC_API_KEY_P8", "")
raw = raw.replace("-----BEGIN PRIVATE KEY----- ", "-----BEGIN PRIVATE KEY-----\n")
raw = raw.replace(" -----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----")
lines = raw.split("\n")
out = []
for line in lines:
    if line.startswith("---"):
        out.append(line)
    else:
        body = line.replace(" ", "")
        for i in range(0, len(body), 64):
            out.append(body[i:i+64])
result = "\n".join(l for l in out if l)
with open("/tmp/AuthKey_RV23AJ8V62.p8", "w") as f:
    f.write(result + "\n")
print("Key written:", len(result), "bytes")
