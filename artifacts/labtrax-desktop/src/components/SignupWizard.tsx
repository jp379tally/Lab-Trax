import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  ApiError,
  checkUsernameAvailable,
  fetchLabGroups,
  lookupLabs,
  sendEmailVerificationCode,
  sendPhoneVerificationCode,
  verifyEmailCode,
  verifyPhoneCode,
  type LabGroup,
  type LabLookupResult,
} from "@/lib/api";

type Step =
  | "credentials"
  | "user_type"
  | "lab_info"
  | "license"
  | "practice_info"
  | "email_verify"
  | "updates_opt_in"
  | "phone_entry"
  | "phone_verify"
  | "phone_contact_name"
  | "role_select"
  | "join_group"
  | "hipaa_disclaimer";

const LAB_STEPS: Step[] = [
  "credentials",
  "user_type",
  "lab_info",
  "email_verify",
  "updates_opt_in",
  "role_select",
  "join_group",
  "hipaa_disclaimer",
];

const PROVIDER_STEPS_NO_UPDATES: Step[] = [
  "credentials",
  "user_type",
  "license",
  "practice_info",
  "email_verify",
  "updates_opt_in",
  "role_select",
  "join_group",
  "hipaa_disclaimer",
];

const PROVIDER_STEPS_WITH_UPDATES: Step[] = [
  "credentials",
  "user_type",
  "license",
  "practice_info",
  "email_verify",
  "updates_opt_in",
  "phone_entry",
  "phone_verify",
  "phone_contact_name",
  "role_select",
  "join_group",
  "hipaa_disclaimer",
];

const STEP_HEADINGS: Record<Step, { title: string; sub: string }> = {
  credentials: { title: "Create your account", sub: "Pick a username, email, and password." },
  user_type: { title: "I am a…", sub: "This sets up your workspace correctly." },
  lab_info: { title: "Lab details", sub: "Tell us about your lab." },
  license: { title: "License number", sub: "Required for verification." },
  practice_info: { title: "Practice details", sub: "Tell us about your practice." },
  email_verify: { title: "Verify your email", sub: "Enter the 6-digit code we sent." },
  updates_opt_in: { title: "Case updates", sub: "Want SMS updates from your lab?" },
  phone_entry: { title: "Your phone number", sub: "We'll text a 6-digit code." },
  phone_verify: { title: "Verify your phone", sub: "Enter the 6-digit code we sent." },
  phone_contact_name: { title: "Contact name", sub: "Who should we text for case updates?" },
  role_select: { title: "Account role", sub: "Pick the role for this account." },
  join_group: { title: "Join an existing lab", sub: "Optional — request to join a registered lab." },
  hipaa_disclaimer: { title: "HIPAA notice", sub: "Please review and accept to finish." },
};

function validatePassword(pw: string) {
  return {
    length: pw.length >= 8,
    upper: /[A-Z]/.test(pw),
    lower: /[a-z]/.test(pw),
    special: /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(pw),
  };
}

// Mirrors the server-side rule (USERNAME_REGEX in api-server auth.ts):
// 3–12 chars, letters/numbers/underscore only.
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,12}$/;

const inputClass =
  "w-full h-10 px-3 rounded-md bg-background border border-input text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary";
const labelClass = "block text-xs font-medium text-foreground mb-1.5";
const primaryBtnClass =
  "w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors";
const secondaryBtnClass =
  "w-full h-10 rounded-md border border-input bg-background text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60 disabled:cursor-not-allowed transition-colors";

interface Props {
  onCancel: () => void;
}

export default function SignupWizard({ onCancel }: Props) {
  const { register } = useAuth();

  const [step, setStep] = useState<Step>("credentials");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Credentials
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pwTouched, setPwTouched] = useState(false);

  // User type
  const [userType, setUserType] = useState<"lab" | "provider" | null>(null);

  // Lab info
  const [labName, setLabName] = useState("");
  const [labStreet, setLabStreet] = useState("");
  const [labCity, setLabCity] = useState("");
  const [labState, setLabState] = useState("");
  const [labZip, setLabZip] = useState("");
  const [labPhone, setLabPhone] = useState("");
  const [labEmail, setLabEmail] = useState("");

  // Provider info
  const [licenseNumber, setLicenseNumber] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [practicePhone, setPracticePhone] = useState("");

  // Claim mode (provider only)
  const [claimMode, setClaimMode] = useState(false);
  const [claimLabSearch, setClaimLabSearch] = useState("");
  const [claimLabResults, setClaimLabResults] = useState<LabLookupResult[]>([]);
  const [claimLabLoading, setClaimLabLoading] = useState(false);
  const [claimLab, setClaimLab] = useState<{ id: string; displayName: string } | null>(null);
  const [claimAccountNumber, setClaimAccountNumber] = useState("");

  // Verification
  const [emailCode, setEmailCode] = useState("");
  const [emailDemoCode, setEmailDemoCode] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneDemoCode, setPhoneDemoCode] = useState<string | null>(null);
  const [resendTimer, setResendTimer] = useState(0);

  // Updates & contact
  const [wantsUpdates, setWantsUpdates] = useState<boolean | null>(null);
  const [phoneContactName, setPhoneContactName] = useState("");

  // Role
  const [selectedRole, setSelectedRole] = useState<"user" | "admin" | null>(null);

  // Join group
  const [labGroups, setLabGroups] = useState<LabGroup[]>([]);
  const [labSearchFilter, setLabSearchFilter] = useState("");
  const [joinTargetOrgId, setJoinTargetOrgId] = useState<string | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);

  // HIPAA
  const [hipaaAccepted, setHipaaAccepted] = useState(false);

  // Resend timer tick
  useEffect(() => {
    if (resendTimer <= 0) return;
    const t = setTimeout(() => setResendTimer((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resendTimer]);

  // Debounced claim lab search
  useEffect(() => {
    if (!claimMode) return;
    const q = claimLabSearch.trim();
    if (q.length < 2 || claimLab) {
      setClaimLabResults([]);
      return;
    }
    let cancelled = false;
    setClaimLabLoading(true);
    const handle = setTimeout(async () => {
      try {
        const labs = await lookupLabs(q);
        if (!cancelled) setClaimLabResults(labs);
      } catch {
        if (!cancelled) setClaimLabResults([]);
      } finally {
        if (!cancelled) setClaimLabLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [claimLabSearch, claimMode, claimLab]);

  const stepSequence = useMemo<Step[]>(() => {
    if (userType === "lab") return LAB_STEPS;
    if (userType === "provider") {
      return wantsUpdates ? PROVIDER_STEPS_WITH_UPDATES : PROVIDER_STEPS_NO_UPDATES;
    }
    return ["credentials", "user_type"];
  }, [userType, wantsUpdates]);

  const currentIdx = Math.max(0, stepSequence.indexOf(step));
  const totalSteps = stepSequence.length;

  const goBack = useCallback(() => {
    setError(null);
    if (step === "credentials") {
      onCancel();
      return;
    }
    if (step === "phone_verify") {
      setStep("phone_entry");
      return;
    }
    const prev = stepSequence[currentIdx - 1];
    if (prev) setStep(prev);
  }, [step, currentIdx, stepSequence, onCancel]);

  function fail(msg: string) {
    setError(msg);
    setBusy(false);
  }

  function clearError() {
    if (error) setError(null);
  }

  async function handleCredentialsNext(e: FormEvent) {
    e.preventDefault();
    if (!username.trim() || !email.trim() || !password) {
      return fail("Please fill in all fields.");
    }
    if (!USERNAME_REGEX.test(username.trim())) {
      return fail(
        "Username must be 3–12 characters using only letters, numbers, or underscores.",
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return fail("Please enter a valid email address.");
    }
    const pw = validatePassword(password);
    if (!pw.length || !pw.upper || !pw.lower || !pw.special) {
      return fail("Password must meet all requirements.");
    }
    if (password !== confirm) {
      return fail("Passwords do not match.");
    }
    setBusy(true);
    setError(null);
    try {
      const available = await checkUsernameAvailable(username.trim());
      if (!available) return fail("That username is already taken.");
      setBusy(false);
      setStep("user_type");
    } catch (err) {
      fail((err as Error)?.message || "Could not validate username.");
    }
  }

  function selectUserType(t: "lab" | "provider") {
    setUserType(t);
    setError(null);
    setStep(t === "lab" ? "lab_info" : "license");
  }

  async function sendEmail() {
    setBusy(true);
    setError(null);
    try {
      const r = await sendEmailVerificationCode(email.trim());
      setEmailDemoCode(r.demoCode ?? null);
      setEmailCode("");
      setResendTimer(60);
      setStep("email_verify");
    } catch (err) {
      fail((err as Error)?.message || "Failed to send code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLabInfoNext(e: FormEvent) {
    e.preventDefault();
    if (
      !labName.trim() ||
      !labStreet.trim() ||
      !labCity.trim() ||
      !labState.trim() ||
      !labZip.trim() ||
      !labPhone.trim() ||
      !labEmail.trim() ||
      !licenseNumber.trim()
    ) {
      return fail("Please fill in all fields.");
    }
    await sendEmail();
  }

  function handleLicenseNext(e: FormEvent) {
    e.preventDefault();
    if (!licenseNumber.trim()) return fail("Please enter your license number.");
    setError(null);
    setStep("practice_info");
  }

  async function handlePracticeInfoNext(e: FormEvent) {
    e.preventDefault();
    if (claimMode) {
      if (!claimLab) return fail("Please pick your lab from the search results.");
      if (!claimAccountNumber.trim()) return fail("Please enter the account number from your lab.");
      await sendEmail();
      return;
    }
    if (
      !practiceName.trim() ||
      !doctorName.trim() ||
      !streetAddress.trim() ||
      !city.trim() ||
      !zipCode.trim() ||
      !practicePhone.trim()
    ) {
      return fail("Please fill in all fields.");
    }
    await sendEmail();
  }

  async function handleVerifyEmail(e: FormEvent) {
    e.preventDefault();
    if (emailCode.length !== 6) return fail("Please enter the 6-digit code.");
    setBusy(true);
    setError(null);
    try {
      await verifyEmailCode(email.trim(), emailCode);
      setBusy(false);
      setStep("updates_opt_in");
    } catch (err) {
      fail((err as Error)?.message || "Verification failed.");
    }
  }

  function handleUpdatesChoice(wants: boolean) {
    setWantsUpdates(wants);
    setError(null);
    if (wants && userType === "provider") {
      setStep("phone_entry");
    } else {
      setStep("role_select");
    }
  }

  async function handlePhoneEntryNext(e: FormEvent) {
    e.preventDefault();
    const cleaned = phoneNumber.replace(/\D/g, "");
    if (cleaned.length < 10) return fail("Please enter a valid phone number.");
    setBusy(true);
    setError(null);
    try {
      const r = await sendPhoneVerificationCode(phoneNumber.trim());
      setPhoneDemoCode(r.demoCode ?? null);
      setPhoneCode("");
      setResendTimer(60);
      setBusy(false);
      setStep("phone_verify");
    } catch (err) {
      fail((err as Error)?.message || "Failed to send code.");
    }
  }

  async function handleVerifyPhone(e: FormEvent) {
    e.preventDefault();
    if (phoneCode.length !== 6) return fail("Please enter the 6-digit code.");
    setBusy(true);
    setError(null);
    try {
      await verifyPhoneCode(phoneNumber.trim(), phoneCode);
      setBusy(false);
      setStep("phone_contact_name");
    } catch (err) {
      fail((err as Error)?.message || "Verification failed.");
    }
  }

  function handlePhoneContactNext(e: FormEvent) {
    e.preventDefault();
    if (!phoneContactName.trim()) return fail("Please enter a contact name.");
    setError(null);
    setStep("role_select");
  }

  function selectRole(role: "user" | "admin") {
    setSelectedRole(role);
    setError(null);
    setStep("join_group");
    void loadLabGroups();
  }

  async function loadLabGroups() {
    if (labGroups.length > 0) return;
    setGroupsLoading(true);
    try {
      const groups = await fetchLabGroups();
      setLabGroups(groups);
    } catch {
      setLabGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  }

  async function completeRegistration() {
    if (!hipaaAccepted) return fail("Please accept the HIPAA notice to continue.");
    if (!userType) return fail("Please choose an account type.");
    setBusy(true);
    setError(null);
    try {
      const isLab = userType === "lab";
      const isClaim = !isLab && claimMode && !!claimLab && !!claimAccountNumber.trim();
      const resolvedAddress = isLab
        ? [labStreet.trim(), labCity.trim(), labState.trim(), labZip.trim()].filter(Boolean).join(", ")
        : [streetAddress.trim(), city.trim(), zipCode.trim()].filter(Boolean).join(", ");
      const resolvedPhone = isLab ? labPhone.trim() : practicePhone.trim();
      const resolvedEmail = isLab ? labEmail.trim() || email.trim() : email.trim();

      // Synthesise a per-user account number similar to the mobile flow.
      const yy = new Date().getFullYear() % 100;
      const acctNum = isLab
        ? `DS-${Date.now().toString().slice(-6)}`
        : `${yy}-${Date.now().toString().slice(-4)}`;

      await register({
        username: username.trim(),
        password,
        email: resolvedEmail,
        phone: wantsUpdates && userType === "provider" ? phoneNumber.trim() : undefined,
        wantsUpdates: !!wantsUpdates,
        userType,
        licenseNumber: licenseNumber.trim() || undefined,
        practiceName: isLab ? labName.trim() : isClaim ? undefined : practiceName.trim(),
        doctorName: isLab ? undefined : doctorName.trim() || undefined,
        practiceAddress: isClaim ? undefined : resolvedAddress,
        practicePhone: isClaim ? undefined : resolvedPhone,
        phoneContactName:
          wantsUpdates && userType === "provider" ? phoneContactName.trim() || undefined : undefined,
        role: selectedRole || "user",
        accountNumber: acctNum,
        createOrganization: !isClaim && !joinTargetOrgId,
        joinOrganizationId: joinTargetOrgId || undefined,
        claimProvider: isClaim
          ? { labId: claimLab!.id, accountNumber: claimAccountNumber.trim() }
          : undefined,
      });
      // Auth context flips to "authed" — the app router will replace this screen.
    } catch (err) {
      if (err instanceof ApiError) {
        fail(err.message);
      } else {
        fail((err as Error)?.message || "Registration failed.");
      }
    }
  }

  const pwReq = validatePassword(password);
  const heading = STEP_HEADINGS[step];

  return (
    <div className="w-full max-w-[460px]">
      <div className="bg-card border border-border rounded-xl shadow-sm p-7">
        {/* Step indicator */}
        <div className="flex items-center gap-1.5 mb-5" aria-label={`Step ${currentIdx + 1} of ${totalSteps}`}>
          {stepSequence.map((s, i) => (
            <span
              key={s}
              className={`h-1 flex-1 rounded-full ${
                i <= currentIdx ? "bg-primary" : "bg-muted"
              }`}
            />
          ))}
        </div>

        <div className="mb-5">
          <h1 className="text-xl font-semibold tracking-tight">{heading.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{heading.sub}</p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md"
          >
            {error}
          </div>
        )}

        {step === "credentials" && (
          <form onSubmit={handleCredentialsNext} className="space-y-4">
            <div>
              <label className={labelClass}>Username</label>
              <input
                className={inputClass}
                value={username}
                autoFocus
                autoComplete="username"
                maxLength={12}
                onChange={(e) => {
                  setUsername(e.target.value);
                  clearError();
                }}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                3–12 characters: letters, numbers, or underscores.
              </p>
            </div>
            <div>
              <label className={labelClass}>Email</label>
              <input
                type="email"
                className={inputClass}
                value={email}
                autoComplete="email"
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearError();
                }}
              />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  className={inputClass + " pr-16"}
                  value={password}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPwTouched(true);
                    clearError();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground px-2 py-1"
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
              {pwTouched && (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {[
                    { label: "8+ characters", met: pwReq.length },
                    { label: "Uppercase letter", met: pwReq.upper },
                    { label: "Lowercase letter", met: pwReq.lower },
                    { label: "Special character", met: pwReq.special },
                  ].map((r) => (
                    <li
                      key={r.label}
                      className={r.met ? "text-emerald-600" : "text-muted-foreground"}
                    >
                      {r.met ? "✓" : "•"} {r.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <label className={labelClass}>Confirm Password</label>
              <input
                type={showPassword ? "text" : "password"}
                className={inputClass}
                value={confirm}
                autoComplete="new-password"
                onChange={(e) => {
                  setConfirm(e.target.value);
                  clearError();
                }}
              />
            </div>
            <button type="submit" disabled={busy} className={primaryBtnClass}>
              {busy ? "Checking…" : "Continue"}
            </button>
          </form>
        )}

        {step === "user_type" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => selectUserType("lab")}
              className="w-full text-left p-4 rounded-md border border-input hover:border-primary hover:bg-muted/50 transition-colors"
            >
              <div className="text-sm font-semibold">Dental Laboratory</div>
              <div className="text-xs text-muted-foreground mt-1">
                I manage cases from dental providers.
              </div>
            </button>
            <button
              type="button"
              onClick={() => selectUserType("provider")}
              className="w-full text-left p-4 rounded-md border border-input hover:border-primary hover:bg-muted/50 transition-colors"
            >
              <div className="text-sm font-semibold">Dental Provider</div>
              <div className="text-xs text-muted-foreground mt-1">
                I'm a dentist sending cases to a lab.
              </div>
            </button>
          </div>
        )}

        {step === "lab_info" && (
          <form onSubmit={handleLabInfoNext} className="space-y-3">
            <div>
              <label className={labelClass}>Lab Name</label>
              <input
                className={inputClass}
                value={labName}
                autoFocus
                onChange={(e) => {
                  setLabName(e.target.value);
                  clearError();
                }}
              />
            </div>
            <div>
              <label className={labelClass}>Street Address</label>
              <input
                className={inputClass}
                value={labStreet}
                onChange={(e) => {
                  setLabStreet(e.target.value);
                  clearError();
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>City</label>
                <input
                  className={inputClass}
                  value={labCity}
                  onChange={(e) => {
                    setLabCity(e.target.value);
                    clearError();
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>State</label>
                  <input
                    className={inputClass}
                    value={labState}
                    maxLength={2}
                    onChange={(e) => {
                      setLabState(e.target.value.toUpperCase());
                      clearError();
                    }}
                  />
                </div>
                <div>
                  <label className={labelClass}>ZIP</label>
                  <input
                    className={inputClass}
                    value={labZip}
                    maxLength={5}
                    onChange={(e) => {
                      setLabZip(e.target.value);
                      clearError();
                    }}
                  />
                </div>
              </div>
            </div>
            <div>
              <label className={labelClass}>Office Phone</label>
              <input
                className={inputClass}
                value={labPhone}
                onChange={(e) => {
                  setLabPhone(e.target.value);
                  clearError();
                }}
              />
            </div>
            <div>
              <label className={labelClass}>Lab Email</label>
              <input
                type="email"
                className={inputClass}
                value={labEmail}
                onChange={(e) => {
                  setLabEmail(e.target.value);
                  clearError();
                }}
              />
            </div>
            <div>
              <label className={labelClass}>Lab License Number</label>
              <input
                className={inputClass}
                value={licenseNumber}
                onChange={(e) => {
                  setLicenseNumber(e.target.value.toUpperCase());
                  clearError();
                }}
              />
            </div>
            <button type="submit" disabled={busy} className={primaryBtnClass}>
              {busy ? "Sending code…" : "Continue"}
            </button>
          </form>
        )}

        {step === "license" && (
          <form onSubmit={handleLicenseNext} className="space-y-4">
            <div>
              <label className={labelClass}>Dental License Number</label>
              <input
                className={inputClass}
                value={licenseNumber}
                autoFocus
                onChange={(e) => {
                  setLicenseNumber(e.target.value.toUpperCase());
                  clearError();
                }}
              />
            </div>
            <button type="submit" className={primaryBtnClass}>
              Continue
            </button>
          </form>
        )}

        {step === "practice_info" && (
          <form onSubmit={handlePracticeInfoNext} className="space-y-3">
            <label className="flex items-start gap-2.5 cursor-pointer select-none p-3 rounded-md border border-input">
              <input
                type="checkbox"
                checked={claimMode}
                onChange={(e) => {
                  setClaimMode(e.target.checked);
                  clearError();
                }}
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary cursor-pointer"
              />
              <span className="text-xs text-foreground leading-relaxed">
                My lab already created my practice — I have an account number
              </span>
            </label>

            {claimMode ? (
              <>
                <div>
                  <label className={labelClass}>Find your lab</label>
                  <input
                    className={inputClass}
                    placeholder="Search by name"
                    value={claimLab ? claimLab.displayName : claimLabSearch}
                    onChange={(e) => {
                      if (claimLab) setClaimLab(null);
                      setClaimLabSearch(e.target.value);
                      clearError();
                    }}
                  />
                  {claimLabLoading && (
                    <p className="text-xs text-muted-foreground mt-1">Searching…</p>
                  )}
                  {!claimLab && claimLabResults.length > 0 && (
                    <div className="mt-2 border border-input rounded-md max-h-44 overflow-auto">
                      {claimLabResults.map((lab) => (
                        <button
                          key={lab.id}
                          type="button"
                          onClick={() => {
                            setClaimLab({ id: lab.id, displayName: lab.displayName });
                            setClaimLabSearch(lab.displayName);
                            setClaimLabResults([]);
                          }}
                          className="block w-full text-left px-3 py-2 text-sm hover:bg-muted border-b border-border last:border-b-0"
                        >
                          <div className="font-medium">{lab.displayName}</div>
                          {(lab.city || lab.state) && (
                            <div className="text-xs text-muted-foreground">
                              {[lab.city, lab.state].filter(Boolean).join(", ")}
                            </div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Account number</label>
                  <input
                    className={inputClass}
                    value={claimAccountNumber}
                    onChange={(e) => {
                      setClaimAccountNumber(e.target.value.toUpperCase());
                      clearError();
                    }}
                  />
                  <p className="text-xs text-muted-foreground mt-1.5">
                    Ask your lab for the account number on your practice. Once they approve, you'll see your existing cases.
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className={labelClass}>Practice Name</label>
                  <input
                    className={inputClass}
                    value={practiceName}
                    onChange={(e) => {
                      setPracticeName(e.target.value);
                      clearError();
                    }}
                  />
                </div>
                <div>
                  <label className={labelClass}>Doctor Name</label>
                  <input
                    className={inputClass}
                    value={doctorName}
                    onChange={(e) => {
                      setDoctorName(e.target.value);
                      clearError();
                    }}
                  />
                </div>
                <div>
                  <label className={labelClass}>Street Address</label>
                  <input
                    className={inputClass}
                    value={streetAddress}
                    onChange={(e) => {
                      setStreetAddress(e.target.value);
                      clearError();
                    }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass}>City</label>
                    <input
                      className={inputClass}
                      value={city}
                      onChange={(e) => {
                        setCity(e.target.value);
                        clearError();
                      }}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>ZIP</label>
                    <input
                      className={inputClass}
                      value={zipCode}
                      maxLength={5}
                      onChange={(e) => {
                        setZipCode(e.target.value);
                        clearError();
                      }}
                    />
                  </div>
                </div>
                <div>
                  <label className={labelClass}>Office Phone</label>
                  <input
                    className={inputClass}
                    value={practicePhone}
                    onChange={(e) => {
                      setPracticePhone(e.target.value);
                      clearError();
                    }}
                  />
                </div>
              </>
            )}

            <button type="submit" disabled={busy} className={primaryBtnClass}>
              {busy ? "Sending code…" : "Continue"}
            </button>
          </form>
        )}

        {step === "email_verify" && (
          <form onSubmit={handleVerifyEmail} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Code sent to <span className="font-medium text-foreground">{email}</span>.
            </p>
            {emailDemoCode && (
              <div className="text-xs text-amber-700 bg-amber-100 border border-amber-200 px-3 py-2 rounded-md">
                Demo code: <span className="font-mono font-semibold">{emailDemoCode}</span>
              </div>
            )}
            <input
              className={inputClass + " text-center font-mono tracking-[0.5em] text-lg"}
              value={emailCode}
              maxLength={6}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              onChange={(e) => {
                setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                clearError();
              }}
            />
            <button
              type="submit"
              disabled={busy || emailCode.length !== 6}
              className={primaryBtnClass}
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              disabled={resendTimer > 0 || busy}
              onClick={() => void sendEmail()}
              className="w-full text-xs text-muted-foreground hover:text-foreground underline disabled:opacity-50"
            >
              {resendTimer > 0 ? `Resend code in ${resendTimer}s` : "Resend code"}
            </button>
          </form>
        )}

        {step === "updates_opt_in" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Would you like to receive case updates and message the lab directly via text?
            </p>
            <button
              type="button"
              onClick={() => handleUpdatesChoice(true)}
              className={primaryBtnClass}
            >
              Yes, sign me up
            </button>
            <button
              type="button"
              onClick={() => handleUpdatesChoice(false)}
              className={secondaryBtnClass}
            >
              No thanks
            </button>
          </div>
        )}

        {step === "phone_entry" && (
          <form onSubmit={handlePhoneEntryNext} className="space-y-4">
            <div>
              <label className={labelClass}>Phone Number</label>
              <input
                className={inputClass}
                value={phoneNumber}
                autoFocus
                inputMode="tel"
                autoComplete="tel"
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  clearError();
                }}
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                We'll send a 6-digit code to verify your number.
              </p>
            </div>
            <button type="submit" disabled={busy} className={primaryBtnClass}>
              {busy ? "Sending…" : "Send Code"}
            </button>
          </form>
        )}

        {step === "phone_verify" && (
          <form onSubmit={handleVerifyPhone} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Code sent to <span className="font-medium text-foreground">{phoneNumber}</span>.
            </p>
            {phoneDemoCode && (
              <div className="text-xs text-amber-700 bg-amber-100 border border-amber-200 px-3 py-2 rounded-md">
                Demo code: <span className="font-mono font-semibold">{phoneDemoCode}</span>
              </div>
            )}
            <input
              className={inputClass + " text-center font-mono tracking-[0.5em] text-lg"}
              value={phoneCode}
              maxLength={6}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              onChange={(e) => {
                setPhoneCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                clearError();
              }}
            />
            <button
              type="submit"
              disabled={busy || phoneCode.length !== 6}
              className={primaryBtnClass}
            >
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              disabled={resendTimer > 0 || busy}
              onClick={() => {
                setBusy(true);
                sendPhoneVerificationCode(phoneNumber.trim())
                  .then((r) => {
                    setPhoneDemoCode(r.demoCode ?? null);
                    setPhoneCode("");
                    setResendTimer(60);
                  })
                  .catch((err: Error) => setError(err?.message || "Failed to resend code."))
                  .finally(() => setBusy(false));
              }}
              className="w-full text-xs text-muted-foreground hover:text-foreground underline disabled:opacity-50"
            >
              {resendTimer > 0 ? `Resend code in ${resendTimer}s` : "Resend code"}
            </button>
          </form>
        )}

        {step === "phone_contact_name" && (
          <form onSubmit={handlePhoneContactNext} className="space-y-4">
            <div>
              <label className={labelClass}>Full name of phone contact</label>
              <input
                className={inputClass}
                value={phoneContactName}
                autoFocus
                onChange={(e) => {
                  setPhoneContactName(e.target.value);
                  clearError();
                }}
              />
              <p className="text-xs text-muted-foreground mt-1.5">
                Who should we text for case updates?
              </p>
            </div>
            <button type="submit" className={primaryBtnClass}>
              Continue
            </button>
          </form>
        )}

        {step === "role_select" && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => selectRole("user")}
              className="w-full text-left p-4 rounded-md border border-input hover:border-primary hover:bg-muted/50 transition-colors"
            >
              <div className="text-sm font-semibold">User</div>
              <div className="text-xs text-muted-foreground mt-1">
                Standard user with access to case management.
              </div>
            </button>
            <button
              type="button"
              onClick={() => selectRole("admin")}
              className="w-full text-left p-4 rounded-md border border-input hover:border-primary hover:bg-muted/50 transition-colors"
            >
              <div className="text-sm font-semibold">Administrator</div>
              <div className="text-xs text-muted-foreground mt-1">
                Full access including pricing and management.
              </div>
            </button>
          </div>
        )}

        {step === "join_group" && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {userType === "lab"
                ? "Optional. Browse registered labs you'd like to join as a member."
                : "Optional. Browse registered labs and request to join one. The lab admin will need to approve."}
            </p>
            <div>
              <input
                className={inputClass}
                placeholder="Search labs…"
                value={labSearchFilter}
                onChange={(e) => setLabSearchFilter(e.target.value)}
              />
            </div>
            <div className="max-h-60 overflow-auto border border-input rounded-md">
              {groupsLoading && (
                <p className="text-xs text-muted-foreground p-4 text-center">Loading labs…</p>
              )}
              {!groupsLoading &&
                labGroups
                  .filter(
                    (g) =>
                      !labSearchFilter ||
                      g.practiceName.toLowerCase().includes(labSearchFilter.toLowerCase()),
                  )
                  .map((g) => {
                    const selected = joinTargetOrgId === g.organizationId;
                    return (
                      <button
                        key={g.organizationId}
                        type="button"
                        onClick={() =>
                          setJoinTargetOrgId(selected ? null : g.organizationId)
                        }
                        className={`block w-full text-left px-3 py-2 text-sm border-b border-border last:border-b-0 hover:bg-muted ${
                          selected ? "bg-primary/10" : ""
                        }`}
                      >
                        <div className="font-medium">{g.practiceName}</div>
                        {g.practiceAddress && (
                          <div className="text-xs text-muted-foreground truncate">
                            {g.practiceAddress}
                          </div>
                        )}
                      </button>
                    );
                  })}
              {!groupsLoading && labGroups.length === 0 && (
                <p className="text-xs text-muted-foreground p-4 text-center">
                  No registered labs found.
                </p>
              )}
            </div>
            {joinTargetOrgId && (
              <p className="text-xs text-muted-foreground">
                A join request will be sent. You'll be added once the admin approves.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("hipaa_disclaimer");
              }}
              className={primaryBtnClass}
            >
              {joinTargetOrgId ? "Continue with join request" : "Skip for now"}
            </button>
          </div>
        )}

        {step === "hipaa_disclaimer" && (
          <div className="space-y-4">
            <div className="max-h-56 overflow-auto p-3 rounded-md border border-input bg-muted/30 text-xs text-foreground space-y-2">
              <p className="font-semibold">HIPAA COMPLIANCE NOTICE</p>
              <p>
                All information within this application is considered HIPAA compliant and is
                handled in accordance with applicable privacy regulations.
              </p>
              <p className="font-semibold mt-2">AUTHORIZATION & LIABILITY</p>
              <p>By creating an account and using this application, you acknowledge that:</p>
              <p>
                1. Any instruction provided through this application to the dental laboratory
                will be carried forth with the assumption that the user has full authority to
                make changes to any case.
              </p>
              <p>
                2. The dental laboratory is relieved of all responsibilities and consequences
                for decisions made or changes made to cases from this application.
              </p>
              <p>
                3. You are solely responsible for the accuracy of all information and
                instructions submitted through this application.
              </p>
              <p className="mt-2">By proceeding, you agree to these terms and conditions.</p>
            </div>
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hipaaAccepted}
                onChange={(e) => {
                  setHipaaAccepted(e.target.checked);
                  clearError();
                }}
                className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
              />
              <span className="text-sm text-foreground">
                I have read and agree to the terms above
              </span>
            </label>
            <button
              type="button"
              onClick={() => void completeRegistration()}
              disabled={!hipaaAccepted || busy}
              className={primaryBtnClass}
            >
              {busy ? "Creating account…" : "Accept & Create Account"}
            </button>
          </div>
        )}

        <div className="flex items-center justify-between mt-5 pt-4 border-t border-border">
          <button
            type="button"
            onClick={goBack}
            disabled={busy}
            className="text-xs text-muted-foreground hover:text-foreground underline disabled:opacity-50"
          >
            {step === "credentials" ? "Back to sign in" : "Back"}
          </button>
          <span className="text-[10px] text-muted-foreground/70">
            Step {currentIdx + 1} of {totalSteps}
          </span>
        </div>
      </div>
    </div>
  );
}
