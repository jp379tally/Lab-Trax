import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class Storage {
  bucket(bucketName) {
    return {
      file: (objectName) => {
        const objectPath = join(
          process.env.MOCK_STORAGE_ROOT,
          bucketName,
          ...objectName.split("/"),
        );
        const key = objectName;

        return {
          async save(bytes) {
            await mkdir(dirname(objectPath), { recursive: true });
            await writeFile(objectPath, bytes);
          },
          async getMetadata() {
            const objectStat = await stat(objectPath);
            const sizeMismatchKey =
              process.env.MOCK_STORAGE_METADATA_SIZE_MISMATCH_FOR;
            const sizeAdjustment =
              sizeMismatchKey === key ? 1 : 0;
            return [{ size: String(objectStat.size + sizeAdjustment) }];
          },
          async download() {
            const bytes = await readFile(objectPath);
            let returnedBytes = bytes;
            if (process.env.MOCK_STORAGE_READBACK_MISMATCH_FOR === key) {
              returnedBytes = Buffer.from(bytes);
              if (returnedBytes.length === 0) {
                returnedBytes.push(0);
              } else {
                returnedBytes[returnedBytes.length - 1] ^= 0xff;
              }
            }
            const readbackLog = process.env.MOCK_STORAGE_READBACK_LOG;
            if (readbackLog) {
              await appendFile(
                readbackLog,
                `${JSON.stringify({
                  key,
                  bytesBase64: returnedBytes.toString("base64"),
                })}\n`,
              );
            }
            return [returnedBytes];
          },
        };
      },
    };
  }
}
