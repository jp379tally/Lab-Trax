type AdvisoryLockClient = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
  release: (destroy?: boolean) => void;
};

type UnlockOperation = () => Promise<void>;

export class SessionAdvisoryLockBundle {
  readonly client: AdvisoryLockClient;
  private unlockOperations: UnlockOperation[] = [];
  private released = false;

  constructor(client: AdvisoryLockClient) {
    this.client = client;
  }

  registerUnlock(unlock: UnlockOperation) {
    if (this.released) {
      throw new Error("Cannot register an advisory lock after bundle release.");
    }
    let unlocked = false;
    const releaseLock = async () => {
      if (unlocked) return;
      unlocked = true;
      await unlock();
    };
    this.unlockOperations.push(releaseLock);
    return releaseLock;
  }

  async release() {
    if (this.released) return;
    this.released = true;

    let firstError: unknown = null;
    for (const unlock of this.unlockOperations.reverse()) {
      try {
        await unlock();
      } catch (error) {
        firstError ??= error;
      }
    }

    let safetyUnlockFailed = false;
    try {
      await this.client.query("SELECT pg_advisory_unlock_all()");
    } catch (error) {
      safetyUnlockFailed = true;
      firstError ??= error;
    } finally {
      this.client.release(safetyUnlockFailed);
    }

    if (firstError) throw firstError;
  }
}