import { describe, it, expect } from "vitest";
import {
  decideAiDoctorAssignment,
  type ProviderEntry,
} from "../../scan/ai-doctor-assignment";

const providers: ProviderEntry[] = [
  { providerName: "Dr. Smith", practiceName: "Smith Dental", clientId: "c1" },
  { providerName: "Dr. Johnson", practiceName: "Johnson Family", clientId: "c2" },
];

describe("decideAiDoctorAssignment", () => {
  it("returns kind=new when no doctorName is provided", () => {
    expect(decideAiDoctorAssignment({}, providers)).toEqual({ kind: "new" });
  });

  it("matches a bare last name to the on-file 'Dr. <Name>' entry as exact", () => {
    const result = decideAiDoctorAssignment({ doctorName: "Smith" }, providers);
    expect(result.kind).toBe("exact");
    if (result.kind === "exact") {
      expect(result.entry.providerName).toBe("Dr. Smith");
      expect(result.entry.clientId).toBe("c1");
    }
  });

  it("returns kind=new when no provider is similar enough", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. Zorblax" },
      providers,
    );
    expect(result.kind).toBe("new");
  });

  it("returns kind=new when the provider list is empty", () => {
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. Smith" },
      [],
    );
    expect(result.kind).toBe("new");
  });

  it("returns a similar entry for a close-but-not-exact spelling", () => {
    // "Smyth" is close to "Smith" — the helper should surface a similar
    // candidate so the screen can prompt the user to confirm rather than
    // silently auto-assigning.
    const result = decideAiDoctorAssignment(
      { doctorName: "Dr. Smyth" },
      providers,
    );
    expect(result.kind).toBe("similar");
    if (result.kind === "similar") {
      expect(result.entry.providerName).toBe("Dr. Smith");
    }
  });
});
