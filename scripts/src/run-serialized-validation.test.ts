import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const wrapper = resolve(import.meta.dirname, "../run-serialized-validation.sh");
const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "release-validation-lock-"));
  directories.push(directory);
  return {
    directory,
    env: {
      ...process.env,
      LABTRAX_VALIDATION_LOCK_FILE: join(directory, "validation.lock"),
    },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("serialized release validation", () => {
  it("runs concurrent gates sequentially without discarding either command", async () => {
    const { directory, env } = await fixture();
    const events = join(directory, "events");
    const command = (id: number) =>
      `printf 'start-${id}\\n' >> '${events}'; sleep 0.2; printf 'end-${id}\\n' >> '${events}'`;
    await Promise.all([1, 2].map((id) => execFileAsync("bash", [wrapper, command(id)], { env })));
    const lines = (await readFile(events, "utf8")).trim().split("\n");
    expect([
      ["start-1", "end-1", "start-2", "end-2"],
      ["start-2", "end-2", "start-1", "end-1"],
    ]).toContainEqual(lines);
  });

  it("preserves failure status and releases the gate for the next command", async () => {
    const { env } = await fixture();
    await expect(execFileAsync("bash", [wrapper, "exit 23"], { env })).rejects.toMatchObject({ code: 23 });
    const next = await execFileAsync("bash", [wrapper, "printf 'next-gate-ok'"], { env, timeout: 5000 });
    expect(next.stdout).toContain("next-gate-ok");
  });

  it("preserves shell pipelines and conjunctions in the original command", async () => {
    const { env } = await fixture();
    const result = await execFileAsync("bash", [wrapper, "printf 'original' | tr a-z A-Z && printf '%s' '-command'"], { env });
    expect(result.stdout).toContain("ORIGINAL-command");
  });

  it("rejects missing or empty commands rather than reporting a pass", async () => {
    await expect(execFileAsync("bash", [wrapper])).rejects.toMatchObject({ code: 64 });
    await expect(execFileAsync("bash", [wrapper, ""])).rejects.toMatchObject({ code: 64 });
  });

  it("bounds gate waiting without interrupting the lock holder", async () => {
    const { directory, env } = await fixture();
    const lockFile = join(directory, "validation.lock");
    const marker = join(directory, "holder-acquired.lock");
    const commandRan = join(directory, "command-ran");
    const holder = spawn(
      "bash",
      ["-lc", `flock --exclusive '${lockFile}' bash -c 'touch "${marker}"; sleep 2'`],
      { stdio: "ignore" },
    );

    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(marker);
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      await access(marker);

      await expect(
        execFileAsync("bash", [wrapper, `touch '${commandRan}'`], {
          env: { ...env, LABTRAX_VALIDATION_LOCK_WAIT_SECONDS: "1" },
        }),
      ).rejects.toMatchObject({ code: 75 });
      await expect(readFile(commandRan, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await new Promise<void>((resolveClose) => {
        if (holder.exitCode !== null) {
          resolveClose();
          return;
        }
        holder.once("close", () => resolveClose());
      });
    }
  });
});
