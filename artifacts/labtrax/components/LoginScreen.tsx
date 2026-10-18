import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  Platform,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Modal,
  Alert,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import * as LocalAuthentication from "expo-local-authentication";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  classifyAccountNumberInput,
  formatAccountNumberForDisplay,
  INVALID_ACCOUNT_NUMBER_MESSAGE,
} from "@workspace/account-number";
import {
  GEO_MESSAGES,
  geolocationErrorMessage,
  withGeoTimeout,
} from "@/lib/geolocation-error";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { generateId, GroupJoinRequest } from "@/lib/data";
import Colors from "@/constants/colors";
import ProviderPlanChoices from "./ProviderPlanChoices";
import type { ProviderSignupTier } from "@workspace/api-client-react";
import { Typography, Spacing } from "@/constants/tokens";
import {
  DismissKeyboardView,
  scrollKeyboardDismissMode,
  useDismissKeyboardOnTap,
} from "@/components/ui/DismissKeyboardView";

type SignUpStep = "plan_select" | "welcome" | "credentials" | "user_type" | "lab_intent" | "lab_name" | "lab_info" | "provider_intent" | "license" | "practice_info" | "join_practice" | "provider_match" | "email_verify" | "updates_opt_in" | "phone_entry" | "phone_verify" | "phone_contact_name" | "join_group" | "hipaa_disclaimer" | "complete";

interface ProviderMatchItem {
  orgId: string;
  practiceName: string;
  labName: string | null;
  platformAccountNumber: string | null;
  city: string | null;
  state: string | null;
}

// Result row from the public practice search used by the "join an existing
// practice" sign-up flow (provider counterpart of the lab lookup).
interface PracticeLookupItem {
  id: string;
  name: string;
  displayName: string;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  parentLabName: string | null;
}

interface PartnerLab {
  id: string;
  selectionKey?: string;
  displayName: string;
  city: string | null;
  state: string | null;
}

function validatePassword(pw: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (pw.length < 8) errors.push("At least 8 characters");
  if (!/[A-Z]/.test(pw)) errors.push("One uppercase letter");
  if (!/[a-z]/.test(pw)) errors.push("One lowercase letter");
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) errors.push("One special character");
  return { valid: errors.length === 0, errors };
}

const SHARED_TEST_EMAIL = "shared-test@example.com";

function isSharedTestEmail(email: string): boolean {
  return email.trim().toLowerCase() === SHARED_TEST_EMAIL;
}

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login, completeTwoFactor, loginWithBiometric, register, registeredUsers } = useAuth();
  const dismissKeyboardOnModalTap = useDismissKeyboardOnTap();
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string>("Biometric");
  const [rememberMe, setRememberMe] = useState(true);

  // Two-factor auth challenge state
  const [twoFactorPendingToken, setTwoFactorPendingToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [trustDevice, setTrustDevice] = useState(true);
  const [isChallenging, setIsChallenging] = useState(false);
  const [diagTapCount, setDiagTapCount] = useState(0);

  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showForgotUsername, setShowForgotUsername] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSuccess, setForgotSuccess] = useState<string | null>(null);
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [demoResetInfo, setDemoResetInfo] = useState<string | null>(null);

  const [signUpStep, setSignUpStepRaw] = useState<SignUpStep>("credentials");
  const [providerPlan, setProviderPlan] = useState<ProviderSignupTier | null>(null);
  const [reuseSubscriptionCard, setReuseSubscriptionCard] = useState(false);
  const [providerPlanConfirmed, setProviderPlanConfirmed] = useState(false);
  function setSignUpStep(next: SignUpStep) {
    setSignUpStepRaw(next === "hipaa_disclaimer" && userType === "provider" && providerIntent !== "join" && !selectedMatchOrgId && !providerPlanConfirmed ? "plan_select" : next);
  }
  const [signUpUsername, setSignUpUsername] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPhone, setSignUpPhone] = useState("");
  const [wantsUpdates, setWantsUpdates] = useState(false);
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [signUpError, setSignUpError] = useState<string | null>(null);
  const [signUpLoading, setSignUpLoading] = useState(false);
  const [emailCheckLoading, setEmailCheckLoading] = useState(false);
  const [emailConflictError, setEmailConflictError] = useState<string | null>(null);

  const [phoneCode, setPhoneCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  const [codeResendTimer, setCodeResendTimer] = useState(0);
  const [demoPhoneCode, setDemoPhoneCode] = useState<string | null>(null);
  const [demoEmailCode, setDemoEmailCode] = useState<string | null>(null);

  const [userType, setUserType] = useState<"provider" | "lab" | null>(null);
  const [labIntent, setLabIntent] = useState<"create" | "join" | null>(null);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [fetchingLocation, setFetchingLocation] = useState(false);
  const [practicePhone, setPracticePhone] = useState("");
  const [phoneContactName, setPhoneContactName] = useState("");
  const [hipaaAccepted, setHipaaAccepted] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [joinGroupAdminUsername, setJoinGroupAdminUsername] = useState("");
  const [joinGroupSent, setJoinGroupSent] = useState(false);
  const [labName, setLabName] = useState("");
  const [labStreet, setLabStreet] = useState("");
  const [labCity, setLabCity] = useState("");
  const [labState, setLabState] = useState("");
  const [labZip, setLabZip] = useState("");
  const [labPhone, setLabPhone] = useState("");
  const [labEmail, setLabEmail] = useState("");
  const [matchingLabGroup, setMatchingLabGroup] = useState<{ organizationId: string; practiceName: string; username: string; practiceAddress?: string; phone?: string | null } | null>(null);
  const [labJoinRequestSent, setLabJoinRequestSent] = useState(false);
  const [checkingLabName, setCheckingLabName] = useState(false);
  const [browseExistingLabs, setBrowseExistingLabs] = useState(false);
  const [allLabGroups, setAllLabGroups] = useState<{ organizationId: string; practiceName: string; username: string; practiceAddress?: string; phone?: string | null; memberCount?: number }[]>([]);
  const [labSearchFilter, setLabSearchFilter] = useState("");
  const [partnerLabs, setPartnerLabs] = useState<PartnerLab[]>([]);
  const [partnersConfirmed, setPartnersConfirmed] = useState(false);
  const registrationInFlight = useRef(false);
  const [webViewportHeight, setWebViewportHeight] = useState<number | undefined>();
  const [webViewportTop, setWebViewportTop] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const update = () => {
      setWebViewportHeight(window.visualViewport?.height ?? window.innerHeight);
      setWebViewportTop(window.visualViewport?.offsetTop ?? 0);
    };
    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const [partnerSearch, setPartnerSearch] = useState("");
  const [partnerResults, setPartnerResults] = useState<PartnerLab[]>([]);
  const [partnerLoading, setPartnerLoading] = useState(false);
  const [partnerSearchError, setPartnerSearchError] = useState<string | null>(null);
  const [selectedMatchOrgId, setSelectedMatchOrgId] = useState<string | null>(null);
  const [providerMatches, setProviderMatches] = useState<ProviderMatchItem[]>([]);
  const [matchLookupLoading, setMatchLookupLoading] = useState(false);

  // Provider intent: create a new practice vs. join an existing one.
  const [providerIntent, setProviderIntent] = useState<"create" | "join" | null>(null);
  const [practiceSearchFilter, setPracticeSearchFilter] = useState("");
  const [practiceResults, setPracticeResults] = useState<PracticeLookupItem[]>([]);
  const [practicesLoading, setPracticesLoading] = useState(false);
  const [practicesError, setPracticesError] = useState<string | null>(null);
  const [practicesRetryToken, setPracticesRetryToken] = useState(0);
  const [joinPracticeOrgId, setJoinPracticeOrgId] = useState<string | null>(null);

  const codeInputRefs = useRef<(TextInput | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkBiometricAvailability();
    AsyncStorage.getItem("@labtrax_remember_me").then((val) => {
      if (val !== null) setRememberMe(val === "true");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (signUpStep !== "join_group" || userType !== "provider") return;
    let cancelled = false;
    const q = partnerSearch.trim();
    setPartnerResults([]);
    setPartnerSearchError(null);
    setPartnerLoading(q.length >= 2);
    if (q.length < 2) return;
    const handle = setTimeout(async () => {
      try {
        const res = await apiRequest("GET", `/api/labs/lookup?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (!cancelled) setPartnerResults(Array.isArray(data?.labs) ? data.labs : []);
      } catch {
        if (!cancelled) setPartnerSearchError("Could not search labs. Check your connection and search again.");
      } finally {
        if (!cancelled) setPartnerLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [partnerSearch, signUpStep, userType]);

  useEffect(() => {
    if (userType !== "provider" || providerIntent === "join" || selectedMatchOrgId) {
      setPartnerLabs([]);
      setPartnersConfirmed(false);
      setPartnerSearch("");
    }
  }, [userType, providerIntent, selectedMatchOrgId]);

  useEffect(() => {
    if (codeResendTimer > 0) {
      timerRef.current = setInterval(() => {
        setCodeResendTimer((prev) => {
          if (prev <= 1) {
            if (timerRef.current) clearInterval(timerRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [codeResendTimer]);

  // Debounced public practice search for the "join an existing practice" flow.
  useEffect(() => {
    if (signUpStep !== "join_practice") return;
    const q = practiceSearchFilter.trim();
    if (q.length < 2) {
      setPracticeResults([]);
      setPracticesLoading(false);
      setPracticesError(null);
      return;
    }
    setPracticesLoading(true);
    setPracticesError(null);
    const handle = setTimeout(async () => {
      try {
        const res = await apiRequest("GET", `/api/practices/lookup?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setPracticeResults(Array.isArray(data?.practices) ? data.practices : []);
      } catch {
        setPracticeResults([]);
        setPracticesError("Could not search practices. Check your connection and try again.");
      }
      setPracticesLoading(false);
    }, 300);
    return () => clearTimeout(handle);
  }, [practiceSearchFilter, signUpStep, practicesRetryToken]);

  function switchToSignUp() {
    setProviderPlan(null);
    setReuseSubscriptionCard(false);
    setProviderPlanConfirmed(false);
    setMode("signup");
    setSignUpStep("welcome");
    setSignUpUsername("");
    setSignUpPassword("");
    setSignUpConfirmPassword("");
    setSignUpEmail("");
    setSignUpPhone("");
    setWantsUpdates(false);
    setSignUpError(null);
    setEmailCheckLoading(false);
    setEmailConflictError(null);
    setPhoneCode("");
    setEmailCode("");
    setError(null);
    setUserType(null);
    setLicenseNumber("");
    setPracticeName("");
    setDoctorName("");
    setStreetAddress("");
    setCity("");
    setZipCode("");
    setPracticePhone("");
    setPhoneContactName("");
    setHipaaAccepted(false);
    setAccountNumber("");
    setJoinGroupAdminUsername("");
    setJoinGroupSent(false);
    setLabIntent(null);
    setBrowseExistingLabs(false);
    setMatchingLabGroup(null);
    setLabJoinRequestSent(false);
    setSelectedMatchOrgId(null);
    setProviderMatches([]);
    setMatchLookupLoading(false);
    setProviderIntent(null);
    setPracticeSearchFilter("");
    setPracticeResults([]);
    setPracticesLoading(false);
    setPracticesError(null);
    setPracticesRetryToken(0);
    setJoinPracticeOrgId(null);
    setPartnerLabs([]);
    setPartnersConfirmed(false);
    setPartnerSearch("");
  }

  function switchToSignIn() {
    setMode("signin");
    setUsername("");
    setPassword("");
    setError(null);
    setSignUpError(null);
  }

  async function checkBiometricAvailability() {
    if (Platform.OS === "web") return;
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(hasHardware && isEnrolled);
      if (hasHardware && isEnrolled) {
        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
        if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
          setBiometricType("Face ID");
        } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
          setBiometricType("Fingerprint");
        }
      }
    } catch {
      setBiometricAvailable(false);
    }
  }

  async function handleBiometricLogin() {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Verify your identity",
        fallbackLabel: "Use password",
        disableDeviceFallback: false,
      });
      if (result.success) {
        setIsLoggingIn(true);
        const res = await loginWithBiometric();
        setIsLoggingIn(false);
        if (!res.success) setError(res.error || "Please sign in with your password first to enable Face ID.");
      }
    } catch {
      setError("Biometric authentication failed.");
    }
  }

  async function handleLogin() {
    if (!username.trim() || !password.trim()) {
      setError("Please enter both username and password.");
      return;
    }
    const accountInput = classifyAccountNumberInput(username.trim());
    if (accountInput.kind === "new-invalid") {
      setError(INVALID_ACCOUNT_NUMBER_MESSAGE);
      return;
    }
    const loginIdentifier =
      accountInput.kind === "new-valid" ? accountInput.normalized : username.trim();
    setError(null);
    setIsLoggingIn(true);
    const result = await login(loginIdentifier, password.trim(), rememberMe);
    setIsLoggingIn(false);
    if (result.requiresTwoFactor && result.pendingToken) {
      setTwoFactorPendingToken(result.pendingToken);
      setTotpCode("");
      setUseBackupCode(false);
      setTrustDevice(true);
      setError(null);
      return;
    }
    if (!result.success) setError(result.error || "Login failed.");
  }

  async function handleTwoFactorChallenge() {
    if (!totpCode.trim() || !twoFactorPendingToken) return;
    setError(null);
    setIsChallenging(true);
    const result = await completeTwoFactor(twoFactorPendingToken, totpCode.trim(), trustDevice);
    setIsChallenging(false);
    if (!result.success) {
      setError(result.error || "Invalid code.");
    }
  }

  function openForgotPassword() {
    setForgotEmail("");
    setForgotSuccess(null);
    setForgotError(null);
    setDemoResetInfo(null);
    setShowForgotPassword(true);
  }

  function openForgotUsername() {
    setForgotEmail("");
    setForgotSuccess(null);
    setForgotError(null);
    setDemoResetInfo(null);
    setShowForgotUsername(true);
  }

  async function handleForgotPassword() {
    if (!forgotEmail.trim()) {
      setForgotError("Please enter your email address.");
      return;
    }
    setForgotLoading(true);
    setForgotError(null);
    setForgotSuccess(null);
    setDemoResetInfo(null);
    try {
      const resp = await apiRequest("POST", "/api/forgot-password", { email: forgotEmail.trim() });
      const data = await resp.json();
      setForgotSuccess(data.message || "If an account with that email exists, a password reset link has been sent.");
      if (data.demoResetLink) {
        setDemoResetInfo(`Demo reset link: ${data.demoResetLink}`);
      }
    } catch (e: any) {
      setForgotError(e?.message || "Failed to process request. Please try again.");
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleForgotUsername() {
    if (!forgotEmail.trim()) {
      setForgotError("Please enter your email address.");
      return;
    }
    setForgotLoading(true);
    setForgotError(null);
    setForgotSuccess(null);
    setDemoResetInfo(null);
    try {
      const resp = await apiRequest("POST", "/api/forgot-username", { email: forgotEmail.trim() });
      const data = await resp.json();
      setForgotSuccess(data.message || "If an account with that email exists, a link has been sent.");
      if (data.demoRecoveryLink) {
        setDemoResetInfo(`Demo link: ${data.demoRecoveryLink}`);
      }
    } catch (e: any) {
      setForgotError(e?.message || "Failed to process request. Please try again.");
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleEmailBlur() {
    const email = signUpEmail.trim();
    if (!email || !email.includes("@")) return;
    setEmailCheckLoading(true);
    setEmailConflictError(null);
    try {
      const res = await apiRequest("GET", `/api/auth/check-email?email=${encodeURIComponent(email)}`);
      const data = await res.json();
      if (data?.data?.available === false && !isSharedTestEmail(email)) {
        setEmailConflictError("An account with this email already exists.");
      }
    } catch {
    }
    setEmailCheckLoading(false);
  }

  async function handleCredentialsNext() {
    if (!signUpUsername.trim()) {
      setSignUpError("Please enter a username.");
      return;
    }
    // Mirrors the server-side rule (USERNAME_REGEX in api-server auth.ts):
    // 3–12 chars, letters/numbers/underscore only.
    if (!/^[a-zA-Z0-9_]{3,12}$/.test(signUpUsername.trim())) {
      setSignUpError("Username must be 3–12 characters using only letters, numbers, or underscores.");
      return;
    }

    const pwCheck = validatePassword(signUpPassword);
    if (!pwCheck.valid) {
      setSignUpError("Password does not meet requirements.");
      return;
    }
    if (signUpPassword !== signUpConfirmPassword) {
      setSignUpError("Passwords do not match.");
      return;
    }
    if (!signUpEmail.trim() || !signUpEmail.includes("@")) {
      setSignUpError("Please enter a valid email address.");
      return;
    }
    const allowsSharedEmail = isSharedTestEmail(signUpEmail);
    if (emailConflictError && !allowsSharedEmail) {
      return;
    }

    const emailMatch = allowsSharedEmail
      ? null
      : registeredUsers.find(
          (u) =>
            u.email &&
            u.email.trim().toLowerCase() === signUpEmail.trim().toLowerCase(),
        );
    if (emailMatch) {
      setSignUpError("This email address is already associated with another account. Please enter a different email.");
      return;
    }

    setSignUpError(null);

    const localMatch = registeredUsers.some(
      u => u.username.toLowerCase() === signUpUsername.trim().toLowerCase()
    );
    if (localMatch) {
      setSignUpError("This username is already in use. Please select another username.");
      return;
    }

    setSignUpLoading(true);

    try {
      const res = await apiRequest("POST", "/api/check-username", { username: signUpUsername.trim() });
      const data = await res.json();

      if (!data.available) {
        setSignUpError("This username is already in use. Please select another username.");
        setSignUpLoading(false);
        return;
      }
    } catch {
    }

    setSignUpLoading(false);
    setSignUpStep("user_type");
  }

  function handleUpdatesChoice(wants: boolean) {
    setWantsUpdates(wants);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (wants && userType !== "lab") {
      setSignUpStep("phone_entry");
    } else if (userType === "lab" && labIntent === "create") {
      setSignUpStep("hipaa_disclaimer");
    } else if (!wants && providerIntent === "join") {
      // Practice joiner who skips updates: no role/lab-connect steps — straight to hipaa
      setSignUpStep("hipaa_disclaimer");
    } else if (!wants && selectedMatchOrgId) {
      // Matched provider who skips updates goes straight to approval/terms.
      setSignUpStep("hipaa_disclaimer");
    } else {
      setSignUpStep(userType === "lab" ? "hipaa_disclaimer" : "join_group");
    }
  }

  async function handlePhoneNext() {
    const cleaned = signUpPhone.replace(/\D/g, "");
    if (cleaned.length < 10) {
      setSignUpError("Please enter a valid phone number.");
      return;
    }
    setSignUpError(null);
    await sendPhoneCode();
  }

  async function sendPhoneCode() {
    setCodeSending(true);
    setSignUpError(null);
    try {
      const res = await apiRequest("POST", "/api/send-phone-code", { phone: signUpPhone.trim() });
      const data = await res.json();
      if (data.demoCode) setDemoPhoneCode(data.demoCode);
      setCodeResendTimer(60);
      setSignUpStep("phone_verify");
      setPhoneCode("");
    } catch (e: any) {
      setSignUpError(e?.message || "Failed to send verification code. Please try again.");
    }
    setCodeSending(false);
  }

  async function handleVerifyPhoneCode() {
    if (phoneCode.length !== 6) {
      setSignUpError("Please enter the 6-digit code.");
      return;
    }
    setSignUpLoading(true);
    setSignUpError(null);
    try {
      const res = await apiRequest("POST", "/api/verify-phone-code", { phone: signUpPhone.trim(), code: phoneCode });
      const data = await res.json();
      if (data.verified) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSignUpStep("phone_contact_name");
      } else {
        setSignUpError(data.error || "Incorrect code.");
      }
    } catch (e: any) {
      setSignUpError(e?.message || "We couldn't verify that code. Please try again.");
    }
    setSignUpLoading(false);
  }

  async function sendEmailCode() {
    setCodeSending(true);
    setSignUpError(null);
    try {
      const res = await apiRequest("POST", "/api/send-email-code", { email: signUpEmail.trim() });
      const data = await res.json();
      if (data.demoCode) setDemoEmailCode(data.demoCode);
      setCodeResendTimer(60);
      setSignUpStep("email_verify");
      setEmailCode("");
    } catch (e: any) {
      setSignUpError(e?.message || "Failed to send verification code. Please try again.");
    }
    setCodeSending(false);
  }

  async function handleVerifyEmailCode() {
    if (emailCode.length !== 6) {
      setSignUpError("Please enter the 6-digit code.");
      return;
    }
    setSignUpLoading(true);
    setSignUpError(null);
    try {
      const res = await apiRequest("POST", "/api/verify-email-code", { email: signUpEmail.trim(), code: emailCode });
      const data = await res.json();
      if (data.verified) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setSignUpStep("updates_opt_in");
      } else {
        setSignUpError(data.error || "Incorrect code.");
      }
    } catch (e: any) {
      setSignUpError(e?.message || "We couldn't verify that code. Please try again.");
    }
    setSignUpLoading(false);
  }

  async function completeRegistration() {
    if (registrationInFlight.current || !hipaaAccepted) return;
    if (userType === "provider" && providerIntent !== "join" && !selectedMatchOrgId && !providerPlan) { setSignUpError("Please explicitly choose a provider plan."); return; }
    registrationInFlight.current = true;
    setSignUpError(null);
    setSignUpLoading(true);
    try {
      // Lab creation retains its legacy account number contract. Provider
      // accounts must not invent a canonical account number on the client.
      const acctNum = userType === "lab" ? "DS-" + Date.now().toString().slice(-6) : undefined;

      const isLab = (userType || "provider") === "lab";
      const resolvedAddress = isLab
        ? [labStreet.trim(), labCity.trim(), labState.trim(), labZip.trim()].filter(Boolean).join(", ")
        : [streetAddress.trim(), city.trim(), state.trim(), zipCode.trim()].filter(Boolean).join(", ");
      const structuredAddress = isLab
        ? { line1: labStreet.trim(), city: labCity.trim(), state: labState.trim(), zip: labZip.trim() }
        : { line1: streetAddress.trim(), city: city.trim(), state: state.trim(), zip: zipCode.trim() };
      const resolvedPhone = isLab ? labPhone.trim() : practicePhone.trim();
      const resolvedEmail = isLab ? (labEmail.trim() || signUpEmail.trim()) : signUpEmail.trim();

      const isMatchedJoin = !isLab && !!selectedMatchOrgId;

      const isLabJoin = isLab && labIntent === "join";
      // Provider joining an existing practice via the "join an existing
      // practice" flow — mirrors the desktop SignupWizard: no new org is
      // created and practice details come from the target organization.
      const isPracticeJoin = !isLab && providerIntent === "join";

      const result = await register({
        providerPlan: userType === "provider" ? providerPlan ?? undefined : undefined,
        reuseSubscriptionCard: userType === "provider" ? reuseSubscriptionCard : undefined,
        username: signUpUsername.trim(),
        password: signUpPassword,
        email: resolvedEmail,
        phone: wantsUpdates ? signUpPhone.trim() : undefined,
        wantsUpdates,
        userType: userType || "provider",
        licenseNumber: licenseNumber.trim(),
        practiceName: isLabJoin || isPracticeJoin || isMatchedJoin ? undefined : (isLab ? labName.trim() : practiceName.trim()),
        doctorName: isPracticeJoin || isMatchedJoin ? undefined : doctorName.trim(),
        practiceAddress: isLabJoin || isPracticeJoin || isMatchedJoin ? undefined : resolvedAddress,
        address: isLabJoin || isPracticeJoin || isMatchedJoin ? undefined : structuredAddress,
        practicePhone: isLabJoin || isPracticeJoin || isMatchedJoin ? undefined : resolvedPhone,
        phoneContactName: wantsUpdates ? phoneContactName.trim() : undefined,
        role: "user",
        ...(acctNum ? { accountNumber: acctNum } : {}),
        createOrganization: isLabJoin || isPracticeJoin || isMatchedJoin ? false : true,
        joinOrganizationId: isLabJoin
          ? matchingLabGroup?.organizationId
          : isPracticeJoin
          ? joinPracticeOrgId ?? undefined
          : isMatchedJoin
          ? selectedMatchOrgId
          : undefined,
        claimProvider: undefined,
        partnerLabSelections: isLab ? undefined : partnerLabs.map((lab) => lab.id),
      });
      if (!result.success) {
        setSignUpError(result.error || "Registration failed.");
      } else {
        if (!isLab && partnerLabs.length > 0) {
          const message = `${partnerLabs.map((lab) => lab.displayName).join(", ")} — approval is pending from each lab.`;
          if (Platform.OS === "web" && typeof window !== "undefined") {
            window.alert(`Partnership requests submitted\n\n${message}`);
          } else {
            Alert.alert("Partnership requests submitted", message);
          }
        }
        // After successful registration the user has a valid session.
        // Flush any join requests that were queued during the join_group step.
        if (isLab) try {
          const stored = await AsyncStorage.getItem("@drivesync_group_join_requests");
          if (stored) {
            const existing: GroupJoinRequest[] = JSON.parse(stored);
            const myUsername = signUpUsername.trim().toLowerCase();
            const myRequests = existing.filter(
              (r) => r.requestingUsername.toLowerCase() === myUsername && r.status === "pending"
            );
            if (myRequests.length > 0) {
              try {
                const groupsRes = await apiRequest("GET", "/api/labs/groups");
                const groupsData = await groupsRes.json();
                const groups: any[] = Array.isArray(groupsData.groups) ? groupsData.groups : [];
                for (const req of myRequests) {
                  const targetGroup = groups.find(
                    (g: any) => g.username.toLowerCase() === req.targetAdminUsername.toLowerCase()
                  );
                  if (targetGroup?.organizationId) {
                    await apiRequest(
                      "POST",
                      `/api/organizations/${targetGroup.organizationId}/join-requests`,
                      {
                        requestedRole: "user",
                        message: req.message || `${signUpUsername.trim()} would like to join ${targetGroup.practiceName}.`,
                      }
                    ).catch(() => {});
                  }
                }
              } catch {}
              const remaining = existing.filter(
                (r) => r.requestingUsername.toLowerCase() !== myUsername
              );
              await AsyncStorage.setItem(
                "@drivesync_group_join_requests",
                JSON.stringify(remaining)
              );
            }
          }
        } catch {}
        // Auth navigation will unmount signup; keep successful registration
        // fenced so a second activation cannot submit the account again.
        return;
      }
    } catch {
      setSignUpError("Registration failed. Please try again.");
    }
    setSignUpLoading(false);
    registrationInFlight.current = false;
  }

  const pwValidation = validatePassword(signUpPassword);

  if (mode === "signup") {
    const isPartnershipStep = signUpStep === "join_group" && userType === "provider";
    const isCredentialsStep = signUpStep === "credentials";
    const credentialProgress = ["welcome", "credentials", "user_type"] as const;
    const credentialStepIndex = credentialProgress.indexOf(
      signUpStep as (typeof credentialProgress)[number],
    );
    const SignupScreenWrapper =
      Platform.OS === "web" ? DismissKeyboardView : View;

    return (
      <SignupScreenWrapper
        style={[styles.container, isPartnershipStep && Platform.OS === "web" && webViewportHeight ? {
          position: "fixed" as any, top: webViewportTop, left: 0, right: 0,
          height: webViewportHeight, minHeight: 0, flex: 0, zIndex: 20,
        } : undefined]}
        testID={
          Platform.OS === "web"
            ? "signup-screen-keyboard-dismiss"
            : "signup-screen"
        }
      >
        <LinearGradient
          colors={isCredentialsStep ? ["#F4F8FC", "#F4F8FC"] : ["#0F172A", "#1E293B", "#0F172A"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex}
        >
          <ScrollView
            style={styles.flex}
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: isCredentialsStep
                  ? (Platform.OS === "web" ? 18 : Math.max(insets.top, 12))
                  : (Platform.OS === "web" ? 67 + 30 : insets.top + 30),
                paddingBottom: isCredentialsStep
                  ? (Platform.OS === "web" ? 24 : Math.max(insets.bottom, 16))
                  : (Platform.OS === "web" ? 34 + 20 : insets.bottom + 20),
              },
              isCredentialsStep && styles.credentialsScrollContent,
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
            showsVerticalScrollIndicator={false}
            testID="signup-scroll"
          >
            <Pressable
              disabled={signUpLoading}
              onPress={() => {
                if (signUpLoading) return;
                setSignUpError(null);
                if (signUpStep === "welcome") {
                  switchToSignIn();
                } else if (signUpStep === "credentials") {
                  switchToSignIn();
                } else if (signUpStep === "user_type") {
                  setSignUpStep("credentials");
                } else if (signUpStep === "lab_intent") {
                  setLabIntent(null);
                  setBrowseExistingLabs(false);
                  setMatchingLabGroup(null);
                  setLabJoinRequestSent(false);
                  setSignUpStep("user_type");
                } else if (signUpStep === "provider_intent") {
                  setProviderIntent(null);
                  setJoinPracticeOrgId(null);
                  setSignUpStep("user_type");
                } else if (signUpStep === "license") {
                  setSignUpStep(userType === "provider" ? "provider_intent" : "user_type");
                } else if (signUpStep === "join_practice") {
                  setJoinPracticeOrgId(null);
                  setSignUpStep("license");
                } else if (signUpStep === "practice_info") {
                  setSignUpStep("license");
                } else if (signUpStep === "lab_name") {
                  setMatchingLabGroup(null);
                  setLabJoinRequestSent(false);
                  setBrowseExistingLabs(labIntent === "join");
                  setSignUpStep("lab_intent");
                } else if (signUpStep === "lab_info") {
                  setSignUpStep("lab_name");
                } else if (signUpStep === "provider_match") {
                  setSignUpStep("practice_info");
                } else if (signUpStep === "email_verify") {
                  if (userType === "lab") {
                    setSignUpStep(labIntent === "join" ? "lab_name" : "lab_info");
                  } else if (providerIntent === "join") {
                    setSignUpStep("join_practice");
                  } else if (providerMatches.length > 0) {
                    setSignUpStep("provider_match");
                  } else {
                    setSignUpStep("practice_info");
                  }
                } else if (signUpStep === "updates_opt_in") {
                  setSignUpStep("email_verify");
                } else if (signUpStep === "phone_entry") {
                  setSignUpStep("updates_opt_in");
                } else if (signUpStep === "phone_verify") {
                  setSignUpStep("phone_entry");
                } else if (signUpStep === "phone_contact_name") {
                  setSignUpStep("phone_verify");
                } else if (signUpStep === "plan_select") {
                  setSignUpStep("join_group");
                } else if (signUpStep === "hipaa_disclaimer" && userType === "provider" && providerIntent !== "join" && !selectedMatchOrgId) {
                  setSignUpStepRaw("plan_select");
                } else if (signUpStep === "hipaa_disclaimer") {
                  if (userType === "lab" && labIntent === "create") {
                    setSignUpStep("updates_opt_in");
                  } else if (userType === "lab" && labIntent === "join") {
                    setSignUpStep("updates_opt_in");
                  } else if (providerIntent === "join") {
                    setSignUpStep(wantsUpdates ? "phone_contact_name" : "updates_opt_in");
                  } else if (selectedMatchOrgId) {
                    setSignUpStep(wantsUpdates ? "phone_contact_name" : "updates_opt_in");
                  } else {
                    setSignUpStep("join_group");
                  }
                } else if (signUpStep === "join_group") {
                  setSignUpStep(wantsUpdates ? "phone_contact_name" : "updates_opt_in");
                }
              }}
              style={({ pressed }) => [
                styles.backBtn,
                isCredentialsStep && styles.credentialsBackBtn,
                pressed && { opacity: 0.6 },
              ]}
              testID="signup-back-btn"
            >
              <Ionicons
                name="arrow-back"
                size={22}
                color={isCredentialsStep ? "#426384" : "rgba(255,255,255,0.7)"}
              />
            </Pressable>

            {isCredentialsStep ? (
              <>
                <View style={styles.credentialsBrandHeader} testID="signup-brand-header">
                  <Image
                    source={require("../assets/images/icon.png")}
                    style={styles.credentialsBrandIcon}
                    accessibilityLabel="LabTrax"
                  />
                  <View style={styles.credentialsBrandCopy}>
                    <Text style={styles.credentialsBrandName}>LabTrax</Text>
                    <Text style={styles.credentialsBrandTagline}>LAB OPERATIONS</Text>
                  </View>
                </View>
                <View style={styles.credentialsCard} testID="signup-credentials-card">
                  <View style={styles.credentialsProgress} accessibilityLabel={`Step ${credentialStepIndex + 1} of ${credentialProgress.length}`} testID="signup-credentials-progress">
                    <View style={styles.credentialsProgressBars}>
                      {credentialProgress.map((_, index) => (
                        <View
                          key={index}
                          style={[
                            styles.credentialsProgressBar,
                            index <= credentialStepIndex && styles.credentialsProgressBarActive,
                          ]}
                        />
                      ))}
                    </View>
                    <Text style={styles.credentialsProgressLabel}>
                      STEP {credentialStepIndex + 1} OF {credentialProgress.length}
                    </Text>
                  </View>
                  <Text style={styles.credentialsHeading}>Create your account</Text>
                  <Text style={styles.credentialsSubheading}>
                    Choose your username, email, and password.
                  </Text>
                  {renderCredentialsStep()}
                  <View style={styles.credentialsSignIn}>
                    <Text style={styles.credentialsSignInText}>Already have an account?</Text>
                    <Pressable
                      onPress={switchToSignIn}
                      accessibilityRole="button"
                      testID="switch-to-signin"
                    >
                      <Text style={styles.credentialsSignInLink}>Sign in</Text>
                    </Pressable>
                  </View>
                </View>
              </>
            ) : (
              <View style={styles.logoSection}>
                <View style={styles.logoContainer}>
                  <LinearGradient
                    colors={[Colors.light.tint, "#3B82F6"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={styles.logoGradient}
                  >
                    <Ionicons name="person-add" size={30} color="#FFF" />
                  </LinearGradient>
                </View>
                <Text style={styles.appName}>Create Account</Text>
                <Text style={styles.appTagline}>
                  {signUpStep === "welcome" && "Your dental lab management platform"}
                  {signUpStep === "user_type" && "What type of account?"}
                  {signUpStep === "lab_intent" && "How do you want to get started?"}
                  {signUpStep === "lab_name" && "Enter your lab name"}
                  {signUpStep === "lab_info" && "Enter your lab details"}
                  {signUpStep === "provider_intent" && "How do you want to get started?"}
                  {signUpStep === "license" && (userType === "lab" ? "Enter your lab license number" : "Enter your dental license number")}
                  {signUpStep === "practice_info" && "Tell us about your practice"}
                  {signUpStep === "join_practice" && "Find your practice"}
                  {signUpStep === "provider_match" && "We found a matching practice"}
                  {signUpStep === "updates_opt_in" && "Stay connected with your lab"}
                  {signUpStep === "phone_entry" && "Enter your phone number"}
                  {signUpStep === "phone_verify" && "Verify your phone number"}
                  {signUpStep === "phone_contact_name" && "Who will receive text updates?"}
                  {signUpStep === "email_verify" && "Verify your email address"}
                  {signUpStep === "plan_select" && "Choose your plan"}
                  {signUpStep === "join_group" && (userType === "lab" ? "Connect with a Provider" : "Partner with a lab")}
                  {signUpStep === "hipaa_disclaimer" && "Review & Accept Terms"}
                </Text>
                {((signUpStep === "lab_info" && labIntent === "create") || (signUpStep === "practice_info" && providerIntent === "create")) && (
                  <Text style={styles.optionCardDesc} testID="creator-ownership-guidance">
                    For a new organization, you’ll be Owner with administrator access. You can transfer ownership to an active member later.
                  </Text>
                )}
              </View>
            )}

            {signUpStep === "welcome" && renderWelcome()}
            {Platform.OS === "web" && signUpStep === "welcome" && (
              <Pressable
                onPress={() => setSignUpStep("credentials")}
                style={({ pressed }) => [
                  styles.welcomeActionButton,
                  pressed && { opacity: 0.85 },
                ]}
                testID="welcome-get-started-btn"
              >
                <Text style={styles.welcomeActionText}>Get Started →</Text>
              </Pressable>
            )}
            {signUpStep === "user_type" && renderUserType()}
            {signUpStep === "lab_intent" && renderLabIntent()}
            {signUpStep === "lab_name" && renderLabName()}
            {signUpStep === "lab_info" && renderLabInfo()}
            {signUpStep === "provider_intent" && renderProviderIntent()}
            {signUpStep === "license" && renderLicense()}
            {signUpStep === "practice_info" && renderPracticeInfo()}
            {signUpStep === "join_practice" && renderJoinPractice()}
            {signUpStep === "provider_match" && renderProviderMatch()}
            {signUpStep === "email_verify" && renderEmailVerify()}
            {signUpStep === "updates_opt_in" && renderUpdatesOptIn()}
            {signUpStep === "phone_entry" && renderPhoneEntry()}
            {signUpStep === "phone_verify" && renderPhoneVerify()}
            {signUpStep === "phone_contact_name" && renderPhoneContactName()}
            {signUpStep === "join_group" && renderJoinGroup()}
            {partnersConfirmed && partnerLabs.length > 0 && (signUpStep === "hipaa_disclaimer" || signUpStep === "plan_select") && (
              <View accessibilityRole="alert" style={[styles.optionCard, styles.optionCardSelected]} testID="partners-confirmed">
                <Text style={styles.fieldLabel}>Partnership selections confirmed: {partnerLabs.map((lab) => lab.displayName).join(", ")}</Text>
                <Text style={styles.optionCardDesc}>Requests will be sent when signup is completed. Each lab must approve your request.</Text>
              </View>
            )}
            {signUpStep === "hipaa_disclaimer" && renderHipaaDisclaimer()}
            {signUpStep === "plan_select" && <View style={{ gap: 16 }}>
              <ProviderPlanChoices selected={providerPlan} onSelect={setProviderPlan} reuseCard={reuseSubscriptionCard} onReuseChange={setReuseSubscriptionCard} />
              <Pressable testID="provider-plan-continue" accessibilityRole="button" accessibilityState={{ disabled: !providerPlan }}
                disabled={!providerPlan} style={[styles.primaryBtn, !providerPlan && { opacity: 0.5 }]}
                onPress={() => { if (!providerPlan) return; setProviderPlanConfirmed(true); setSignUpStepRaw("hipaa_disclaimer"); }}>
                <Text style={styles.primaryBtnText}>Continue with selected plan</Text>
              </Pressable>
            </View>}

            {!isCredentialsStep && <View style={styles.stepIndicator}>
              {(() => {
                const labCreateSteps: SignUpStep[] = ["credentials", "user_type", "lab_intent", "lab_name", "lab_info", "email_verify", "updates_opt_in", "hipaa_disclaimer"];
                const labJoinSteps: SignUpStep[] = ["credentials", "user_type", "lab_intent", "lab_name", "email_verify", "updates_opt_in", "hipaa_disclaimer"];
                const providerJoinSteps: SignUpStep[] = wantsUpdates
                  ? ["credentials", "user_type", "provider_intent", "license", "join_practice", "email_verify", "updates_opt_in", "phone_entry", "phone_verify", "phone_contact_name", "hipaa_disclaimer"]
                  : ["credentials", "user_type", "provider_intent", "license", "join_practice", "email_verify", "updates_opt_in", "hipaa_disclaimer"];
                const providerSteps: SignUpStep[] = wantsUpdates
                  ? (selectedMatchOrgId
                    ? ["credentials", "user_type", "provider_intent", "license", "practice_info", "provider_match", "email_verify", "updates_opt_in", "phone_entry", "phone_verify", "phone_contact_name", "hipaa_disclaimer"]
                    : providerMatches.length > 0
                    ? ["credentials", "user_type", "provider_intent", "license", "practice_info", "provider_match", "email_verify", "updates_opt_in", "phone_entry", "phone_verify", "phone_contact_name", "join_group", "hipaa_disclaimer"]
                    : ["credentials", "user_type", "provider_intent", "license", "practice_info", "email_verify", "updates_opt_in", "phone_entry", "phone_verify", "phone_contact_name", "join_group", "hipaa_disclaimer"])
                  : (selectedMatchOrgId
                    ? ["credentials", "user_type", "provider_intent", "license", "practice_info", "provider_match", "email_verify", "updates_opt_in", "hipaa_disclaimer"]
                    : providerMatches.length > 0
                    ? ["credentials", "user_type", "provider_intent", "license", "practice_info", "provider_match", "email_verify", "updates_opt_in", "join_group", "hipaa_disclaimer"]
                    : ["credentials", "user_type", "provider_intent", "license", "practice_info", "email_verify", "updates_opt_in", "join_group", "hipaa_disclaimer"]);
                if (userType === "provider" && providerIntent !== "join" && !selectedMatchOrgId) {
                  providerSteps.splice(providerSteps.indexOf("hipaa_disclaimer"), 0, "plan_select");
                }
                const allSteps = userType === "lab"
                  ? (labIntent === "join" ? labJoinSteps : labCreateSteps)
                  : (providerIntent === "join" ? providerJoinSteps : providerSteps);
                const currentIdx = allSteps.indexOf(signUpStep);
                return allSteps.map((s) => {
                  const stepIdx = allSteps.indexOf(s);
                  const isActive = stepIdx <= currentIdx;
                  return (
                    <View
                      key={s}
                      style={[styles.stepDot, isActive && styles.stepDotActive]}
                    />
                  );
                });
              })()}
            </View>}
          </ScrollView>
          {isPartnershipStep && (
            <View testID="partnership-action-bar" style={{
              flexShrink: 0, paddingHorizontal: 20, paddingTop: 12,
              paddingBottom: Math.max(insets.bottom, 12), backgroundColor: "#1E293B",
              borderTopWidth: 1, borderTopColor: "#475569", gap: 8,
            }}>
              <Text style={styles.optionCardDesc}>Requests will be sent when signup is completed.</Text>
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: signUpLoading || partnerLabs.length === 0 }}
                disabled={signUpLoading || partnerLabs.length === 0}
                style={[styles.primaryBtn, (signUpLoading || partnerLabs.length === 0) && { opacity: 0.5 }]}
                testID="partner-labs-continue" onPress={() => {
                  if (signUpLoading || partnerLabs.length === 0) return;
                  setSignUpError(null); setPartnersConfirmed(true); setSignUpStep("hipaa_disclaimer");
                }}>
                <Text style={styles.primaryBtnText}>Submit partnership request</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={signUpLoading} accessibilityState={{ disabled: signUpLoading }} testID="partner-labs-skip"
                style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}
                onPress={() => {
                  if (signUpLoading) return;
                  setPartnerLabs([]); setPartnersConfirmed(false); setSignUpError(null); setSignUpStep("hipaa_disclaimer");
                }}>
                <Text style={styles.optionCardDesc}>Skip for now</Text>
              </Pressable>
            </View>
          )}
          {Platform.OS !== "web" && signUpStep === "welcome" && (
            <View
              style={[
                styles.welcomeActionFooter,
                {
                  paddingBottom: insets.bottom + 12,
                },
              ]}
              testID="welcome-action-footer"
            >
              <Pressable
                onPress={() => setSignUpStep("credentials")}
                style={({ pressed }) => [
                  styles.welcomeActionButton,
                  pressed && { opacity: 0.85 },
                ]}
                testID="welcome-get-started-btn"
              >
                <Text style={styles.welcomeActionText}>Get Started →</Text>
              </Pressable>
            </View>
          )}
        </KeyboardAvoidingView>
      </SignupScreenWrapper>
    );
  }

  function renderUserType() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <Pressable
          onPress={() => {
            setUserType("provider");
            setProviderIntent(null);
            setJoinPracticeOrgId(null);
            setPracticeSearchFilter("");
            setPracticeResults([]);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("provider_intent");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            userType === "provider" && styles.optionCardSelected,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="user-type-provider"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={[Colors.light.tint, "#3B82F6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="medkit" size={28} color="#FFF" />
            </LinearGradient>
            {userType === "provider" && (
              <View style={styles.optionCheckBadge}>
                <Ionicons name="checkmark-circle" size={24} color={Colors.light.tint} />
              </View>
            )}
          </View>
          <Text style={styles.optionCardTitle}>Dental Provider</Text>
          <Text style={styles.optionCardDesc}>Dental office or practice managing cases and patients</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            setUserType("lab");
            setLabIntent(null);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("lab_intent");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            userType === "lab" && styles.optionCardSelected,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="user-type-lab"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#6366F1", "#8B5CF6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="flask" size={28} color="#FFF" />
            </LinearGradient>
            {userType === "lab" && (
              <View style={styles.optionCheckBadge}>
                <Ionicons name="checkmark-circle" size={24} color={Colors.light.tint} />
              </View>
            )}
          </View>
          <Text style={styles.optionCardTitle}>Dental Lab</Text>
          <Text style={styles.optionCardDesc}>Laboratory processing and fulfilling dental cases</Text>
        </Pressable>
      </View>
    );
  }

  function renderLabIntent() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <Pressable
          onPress={() => {
            setLabIntent("join");
            loadAllLabGroups();
            setBrowseExistingLabs(true);
            setLabSearchFilter("");
            setMatchingLabGroup(null);
            setLabJoinRequestSent(false);
            setSignUpError(null);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("lab_name");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="lab-intent-join"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#3B82F6", "#1D4ED8"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="people" size={28} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.optionCardTitle}>Join an existing lab</Text>
          <Text style={styles.optionCardDesc}>Your lab is already on LabTrax — request to join as a member</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            setLabIntent("create");
            setMatchingLabGroup(null);
            setLabJoinRequestSent(false);
            setBrowseExistingLabs(false);
            setSignUpError(null);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("lab_name");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="lab-intent-create"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#6366F1", "#8B5CF6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="flask" size={28} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.optionCardTitle}>Create my own lab</Text>
          <Text style={styles.optionCardDesc}>Register a new dental lab — you'll be set up as the administrator</Text>
        </Pressable>
      </View>
    );
  }

  function renderProviderIntent() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <Pressable
          onPress={() => {
            setProviderIntent("join");
            setJoinPracticeOrgId(null);
            setPracticeSearchFilter("");
            setPracticeResults([]);
            setSignUpError(null);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("license");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="provider-intent-join"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#3B82F6", "#1D4ED8"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="people" size={28} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.optionCardTitle}>Join an existing practice</Text>
          <Text style={styles.optionCardDesc}>Your practice is already on LabTrax — request to join as a member</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            setProviderIntent("create");
            setJoinPracticeOrgId(null);
            setSignUpError(null);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("license");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="provider-intent-create"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={[Colors.light.tint, "#3B82F6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="medkit" size={28} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.optionCardTitle}>Set up a new practice</Text>
          <Text style={styles.optionCardDesc}>Register your dental practice on LabTrax</Text>
        </Pressable>
      </View>
    );
  }

  function renderJoinPractice() {
    const selectedPractice = joinPracticeOrgId
      ? practiceResults.find((p) => p.id === joinPracticeOrgId) || null
      : null;
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        {!selectedPractice ? (
          <View style={{ gap: 12 }}>
            <View style={styles.inputWrapper}>
              <Ionicons name="search" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={practiceSearchFilter}
                onChangeText={(t) => { setPracticeSearchFilter(t); setSignUpError(null); }}
                placeholder="Search practices by name..."
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="none"
                testID="practice-search-input"
              />
            </View>

            {practicesLoading ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <ActivityIndicator size="small" color="rgba(255,255,255,0.6)" />
              </View>
            ) : practicesError ? (
              <View style={{ padding: 24, alignItems: "center", gap: 12 }} testID="practice-search-error">
                <Ionicons name="cloud-offline-outline" size={32} color="rgba(239,68,68,0.7)" />
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(239,68,68,0.9)", marginTop: 4, textAlign: "center" }}>
                  {practicesError}
                </Text>
                <Pressable
                  onPress={() => setPracticesRetryToken((t) => t + 1)}
                  testID="practice-search-retry-btn"
                  style={({ pressed }) => ({
                    paddingVertical: 8,
                    paddingHorizontal: 20,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "rgba(239,68,68,0.5)",
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text style={{ fontSize: 13, fontFamily: "Inter_600SemiBold", color: "rgba(239,68,68,0.9)" }}>Retry</Text>
                </Pressable>
              </View>
            ) : practiceSearchFilter.trim().length < 2 ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <Ionicons name="business-outline" size={32} color="rgba(255,255,255,0.2)" />
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.4)", marginTop: 8, textAlign: "center" }}>
                  Type at least 2 characters to search for your practice
                </Text>
              </View>
            ) : practiceResults.length === 0 ? (
              <View style={{ padding: 24, alignItems: "center" }}>
                <Ionicons name="business-outline" size={32} color="rgba(255,255,255,0.2)" />
                <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.4)", marginTop: 8, textAlign: "center" }}>
                  No practices match your search
                </Text>
              </View>
            ) : (
              <ScrollView
                style={{ maxHeight: 240 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={scrollKeyboardDismissMode}
              >
                {practiceResults.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setJoinPracticeOrgId(p.id);
                      setSignUpError(null);
                    }}
                    style={({ pressed }) => ({
                      flexDirection: "row", alignItems: "center", gap: 12,
                      backgroundColor: pressed ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.06)",
                      borderRadius: 12, padding: 14, marginBottom: 8,
                      borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
                    })}
                    testID={`practice-result-${p.id}`}
                  >
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(59,130,246,0.2)", justifyContent: "center", alignItems: "center" }}>
                      <Ionicons name="medkit" size={20} color="#3B82F6" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>{p.displayName || p.name}</Text>
                      {(p.addressLine1 || p.city) && (
                        <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                          {[p.addressLine1, p.city, p.state].filter(Boolean).join(", ")}
                        </Text>
                      )}
                      {p.parentLabName && (
                        <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                          Lab: {p.parentLabName}
                        </Text>
                      )}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.3)" />
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <Pressable
              onPress={() => {
                setProviderIntent("create");
                setJoinPracticeOrgId(null);
                setSignUpError(null);
                setSignUpStep("practice_info");
              }}
              style={({ pressed }) => [
                { alignItems: "center", paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
                pressed && { opacity: 0.7 },
              ]}
              testID="practice-create-instead-btn"
            >
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.6)" }}>Set Up a New Practice Instead</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 20, gap: 12 }}>
            <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "rgba(16,185,129,0.2)", justifyContent: "center", alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={36} color="#10B981" />
            </View>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Practice Selected</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 18 }}>
              You'll request to join {selectedPractice.displayName || selectedPractice.name}. Complete registration to submit your join request — a practice admin (or its lab) will review it.
            </Text>
            <Pressable
              onPress={() => {
                sendEmailCode();
              }}
              disabled={codeSending}
              style={({ pressed }) => [
                styles.loginBtn,
                { marginTop: 8 },
                codeSending && { opacity: 0.6 },
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
              testID="join-practice-continue-btn"
            >
              {codeSending ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Text style={styles.loginBtnText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={20} color="#FFF" />
                </>
              )}
            </Pressable>
            <Pressable
              onPress={() => { setJoinPracticeOrgId(null); setSignUpError(null); }}
              style={({ pressed }) => [
                { alignItems: "center", paddingVertical: 12, marginTop: 4 },
                pressed && { opacity: 0.7 },
              ]}
              testID="practice-back-to-list-btn"
            >
              <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.5)" }}>Back to Practice List</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  async function loadAllLabGroups() {
    try {
      const res = await apiRequest("GET", "/api/labs/groups");
      const data = await res.json();
      const groups: any[] = Array.isArray(data.groups) ? data.groups : [];
      setAllLabGroups(groups);
    } catch {
      setAllLabGroups([]);
    }
  }

  async function checkLabName() {
    if (!labName.trim()) {
      setSignUpError("Please enter a lab name.");
      return;
    }
    setCheckingLabName(true);
    setSignUpError(null);
    try {
      const res = await apiRequest("GET", "/api/labs/groups");
      const data = await res.json();
      const groups: any[] = Array.isArray(data.groups) ? data.groups : [];
      const match = groups.find(
        (g: any) => g.practiceName.toLowerCase().trim() === labName.toLowerCase().trim()
      );
      if (match) {
        setMatchingLabGroup({ organizationId: match.organizationId, practiceName: match.practiceName, username: match.username, practiceAddress: match.practiceAddress, phone: match.phone });
        setCheckingLabName(false);
      } else {
        setMatchingLabGroup(null);
        setCheckingLabName(false);
        setSignUpStep("lab_info");
      }
    } catch {
      setMatchingLabGroup(null);
      setCheckingLabName(false);
      setSignUpStep("lab_info");
    }
  }

  function handleJoinExistingLab() {
    if (!matchingLabGroup) return;
    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setLabJoinRequestSent(true);
  }

  function renderLabName() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        {!matchingLabGroup && !browseExistingLabs ? (
          <>
            <View style={styles.inputWrapper}>
              <Ionicons name="flask-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={labName}
                onChangeText={(t) => { setLabName(t); setSignUpError(null); }}
                placeholder="Lab Name"
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="words"
                testID="lab-name-input"
              />
            </View>

            <Pressable
              onPress={checkLabName}
              disabled={checkingLabName || !labName.trim()}
              style={({ pressed }) => [
                styles.loginBtn,
                (!labName.trim() || checkingLabName) && { opacity: 0.5 },
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
              testID="lab-name-next-btn"
            >
              {checkingLabName ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Text style={styles.loginBtnText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={20} color="#FFF" />
                </>
              )}
            </Pressable>

            <View style={{ alignItems: "center", marginTop: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <View style={{ flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.4)" }}>or</Text>
                <View style={{ flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.12)" }} />
              </View>
              <Pressable
                onPress={() => {
                  loadAllLabGroups();
                  setBrowseExistingLabs(true);
                  setLabSearchFilter("");
                  setSignUpError(null);
                }}
                style={({ pressed }) => [
                  {
                    flexDirection: "row", alignItems: "center", gap: 8,
                    paddingVertical: 14, paddingHorizontal: 20, borderRadius: 14,
                    borderWidth: 1, borderColor: "rgba(255,255,255,0.15)",
                  },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Ionicons name="business-outline" size={18} color="rgba(255,255,255,0.7)" />
                <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.7)" }}>Join an Existing Lab</Text>
              </Pressable>
            </View>
          </>
        ) : browseExistingLabs && !matchingLabGroup ? (
          <View style={{ gap: 12 }}>
            <View style={styles.inputWrapper}>
              <Ionicons name="search" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={labSearchFilter}
                onChangeText={setLabSearchFilter}
                placeholder="Search labs..."
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="none"
              />
            </View>

            <ScrollView
              style={{ maxHeight: 240 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={scrollKeyboardDismissMode}
            >
              {allLabGroups
                .filter(g => !labSearchFilter || g.practiceName.toLowerCase().includes(labSearchFilter.toLowerCase()))
                .length === 0 ? (
                <View style={{ padding: 24, alignItems: "center" }}>
                  <Ionicons name="business-outline" size={32} color="rgba(255,255,255,0.2)" />
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.4)", marginTop: 8, textAlign: "center" }}>
                    {allLabGroups.length === 0 ? "No labs registered yet" : "No labs match your search"}
                  </Text>
                </View>
              ) : (
                allLabGroups
                  .filter(g => !labSearchFilter || g.practiceName.toLowerCase().includes(labSearchFilter.toLowerCase()))
                  .map(g => (
                    <Pressable
                      key={g.username}
                      onPress={() => {
                        setMatchingLabGroup(g);
                        setLabJoinRequestSent(false);
                        setSignUpError(null);
                      }}
                      style={({ pressed }) => ({
                        flexDirection: "row", alignItems: "center", gap: 12,
                        backgroundColor: pressed ? "rgba(59,130,246,0.15)" : "rgba(255,255,255,0.06)",
                        borderRadius: 12, padding: 14, marginBottom: 8,
                        borderWidth: 1, borderColor: "rgba(255,255,255,0.1)",
                      })}
                    >
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(59,130,246,0.2)", justifyContent: "center", alignItems: "center" }}>
                        <Ionicons name="business" size={20} color="#3B82F6" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>{g.practiceName}</Text>
                        {g.practiceAddress && <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{g.practiceAddress}</Text>}
                        {g.phone && <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>{g.phone}</Text>}
                      </View>
                      <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.3)" />
                    </Pressable>
                  ))
              )}
            </ScrollView>

            <Pressable
              onPress={() => { setLabIntent("create"); setBrowseExistingLabs(false); setSignUpError(null); }}
              style={({ pressed }) => [
                { alignItems: "center", paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={{ fontSize: 14, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.6)" }}>Create a New Lab Instead</Text>
            </Pressable>
          </View>
        ) : !labJoinRequestSent ? (
          <View style={{ gap: 16 }}>
            <View style={{ backgroundColor: "rgba(59,130,246,0.1)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 14, padding: 20, alignItems: "center" }}>
              <Ionicons name="business" size={32} color="#3B82F6" style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF", textAlign: "center", marginBottom: 4 }}>
                "{matchingLabGroup?.practiceName}" already exists
              </Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 18 }}>
                A lab with this name is already registered. Would you like to request to join this lab?
              </Text>
            </View>

            <Pressable
              onPress={handleJoinExistingLab}
              style={({ pressed }) => [
                styles.loginBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
              testID="join-existing-lab-btn"
            >
              <Ionicons name="people" size={20} color="#FFF" />
              <Text style={styles.loginBtnText}>Request to Join</Text>
            </Pressable>

            <Pressable
              onPress={() => {
                setLabIntent("create");
                setMatchingLabGroup(null);
                setSignUpError(null);
                setBrowseExistingLabs(false);
                setSignUpStep("lab_info");
              }}
              style={({ pressed }) => [
                {
                  alignItems: "center",
                  paddingVertical: 14,
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: "rgba(255,255,255,0.15)",
                },
                pressed && { opacity: 0.7 },
              ]}
              testID="create-new-lab-btn"
            >
              <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.7)" }}>
                Create New Lab Instead
              </Text>
            </Pressable>

            {browseExistingLabs && (
              <Pressable
                onPress={() => { setMatchingLabGroup(null); setSignUpError(null); }}
                style={({ pressed }) => [
                  { alignItems: "center", paddingVertical: 12, marginTop: 4 },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={{ fontSize: 14, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.5)" }}>Back to Lab List</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 20, gap: 12 }}>
            <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "rgba(16,185,129,0.2)", justifyContent: "center", alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={36} color="#10B981" />
            </View>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Lab Selected</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 18 }}>
              You'll be joining {matchingLabGroup?.practiceName}. Complete registration to submit your join request.
            </Text>
            <Pressable
              onPress={() => {
                sendEmailCode();
              }}
              disabled={codeSending}
              style={({ pressed }) => [
                styles.loginBtn,
                { marginTop: 8 },
                codeSending && { opacity: 0.6 },
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
            >
              {codeSending ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Text style={styles.loginBtnText}>Continue</Text>
                  <Ionicons name="arrow-forward" size={20} color="#FFF" />
                </>
              )}
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  function renderLabInfo() {
    const labInfoComplete = labStreet.trim() && labCity.trim() && labState.trim() && labZip.trim() && labPhone.trim() && labEmail.trim();
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.inputWrapper}>
          <Ionicons name="location-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={labStreet}
            onChangeText={(t) => { setLabStreet(t); setSignUpError(null); }}
            placeholder="Street Address"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="words"
            testID="lab-info-street"
          />
        </View>

        <View style={styles.inputWrapper}>
          <Ionicons name="business-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={labCity}
            onChangeText={(t) => { setLabCity(t); setSignUpError(null); }}
            placeholder="City"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="words"
            testID="lab-info-city"
          />
        </View>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={[styles.inputWrapper, { flex: 1 }]}>
            <TextInput
              style={styles.input}
              value={labState}
              onChangeText={(t) => { setLabState(t); setSignUpError(null); }}
              placeholder="State"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="characters"
              maxLength={2}
              testID="lab-info-state"
            />
          </View>
          <View style={[styles.inputWrapper, { flex: 1 }]}>
            <TextInput
              style={styles.input}
              value={labZip}
              onChangeText={(t) => { setLabZip(t); setSignUpError(null); }}
              placeholder="ZIP Code"
              placeholderTextColor="rgba(255,255,255,0.3)"
              keyboardType="number-pad"
              maxLength={5}
              testID="lab-info-zip"
            />
          </View>
        </View>

        <View style={styles.inputWrapper}>
          <Ionicons name="call-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={labPhone}
            onChangeText={(t) => { setLabPhone(t); setSignUpError(null); }}
            placeholder="Office Phone Number"
            placeholderTextColor="rgba(255,255,255,0.3)"
            keyboardType="phone-pad"
            testID="lab-info-phone"
          />
        </View>

        <View style={styles.inputWrapper}>
          <Ionicons name="mail-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={labEmail}
            onChangeText={(t) => { setLabEmail(t); setSignUpError(null); }}
            placeholder="Lab Email Address"
            placeholderTextColor="rgba(255,255,255,0.3)"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            testID="lab-info-email"
          />
        </View>

        <Pressable
          onPress={() => {
            if (!labStreet.trim() || !labCity.trim() || !labState.trim() || !labZip.trim() || !labPhone.trim() || !labEmail.trim()) {
              setSignUpError("Please fill in all fields.");
              return;
            }
            const enteredPhone = labPhone.trim().replace(/\D/g, "");
            const enteredEmail = labEmail.trim().toLowerCase();
            const enteredAddress = [labStreet.trim(), labCity.trim(), labState.trim(), labZip.trim()].filter(Boolean).join(", ").toLowerCase();

            const phoneMatch = registeredUsers.find(u => u.practicePhone && u.practicePhone.replace(/\D/g, "") === enteredPhone && enteredPhone.length >= 7);
            if (phoneMatch) {
              setSignUpError("This phone number is already associated with another account. Please enter a different phone number.");
              return;
            }
            const emailMatch = registeredUsers.find(u => u.email && u.email.toLowerCase() === enteredEmail);
            if (emailMatch) {
              setSignUpError("This email address is already associated with another account. Please enter a different email.");
              return;
            }
            const addressMatch = registeredUsers.find(u => u.practiceAddress && u.practiceAddress.toLowerCase() === enteredAddress);
            if (addressMatch) {
              setSignUpError("This address is already associated with another account. Please enter a different address.");
              return;
            }
            setSignUpError(null);
            sendEmailCode();
          }}
          disabled={!labInfoComplete}
          style={({ pressed }) => [
            styles.loginBtn,
            !labInfoComplete && { opacity: 0.5 },
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="lab-info-next-btn"
        >
          <Text style={styles.loginBtnText}>Continue</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </Pressable>
      </View>
    );
  }

  function renderLicense() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.inputWrapper}>
          <Ionicons name="document-text-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={licenseNumber}
            onChangeText={(t) => { setLicenseNumber(t); setSignUpError(null); }}
            placeholder={userType === "lab" ? "Lab License Number" : "Dental License Number"}
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="characters"
            autoCorrect={false}
            testID="license-number"
          />
        </View>

        <Pressable
          onPress={() => {
            if (!licenseNumber.trim()) {
              setSignUpError(userType === "lab" ? "Please enter your lab license number." : "Please enter your dental license number.");
              return;
            }
            setSignUpError(null);
            setSignUpStep(userType === "provider" && providerIntent === "join" ? "join_practice" : "practice_info");
          }}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
          testID="license-next-btn"
        >
          <Text style={styles.loginBtnText}>Continue</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </Pressable>
      </View>
    );
  }

  async function fetchLocationAddress() {
    try {
      setFetchingLocation(true);
      setSignUpError(null);
      if (Platform.OS === "web") {
        if (!navigator?.geolocation) {
          setSignUpError(GEO_MESSAGES.webUnsupported);
          return;
        }
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
        });
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`, {
          headers: { "User-Agent": "DriveSync-Lab/1.0" },
        });
        const data = await resp.json();
        if (data?.address) {
          const a = data.address;
          const streetParts = [a.house_number, a.road].filter(Boolean);
          if (streetParts.length) setStreetAddress(streetParts.join(" "));
          if (a.city || a.town || a.village) setCity(a.city || a.town || a.village);
          if (a.postcode) setZipCode(a.postcode);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else if (data?.display_name) {
          setStreetAddress(data.display_name);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        } else {
          setSignUpError(GEO_MESSAGES.noAddress);
        }
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          setSignUpError(GEO_MESSAGES.permissionDenied);
          return;
        }
        // expo-location's getCurrentPositionAsync has no built-in timeout, so a
        // stuck GPS fix would spin the button forever. Bound it so the user
        // always gets an actionable message instead of a silent hang.
        const loc = await withGeoTimeout(
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
          15000,
        );
        const geocode = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        if (geocode && geocode.length > 0) {
          const g = geocode[0];
          const streetParts = [g.streetNumber, g.street].filter(Boolean);
          if (streetParts.length) setStreetAddress(streetParts.join(" "));
          if (g.city) setCity(g.city);
          if (g.postalCode) setZipCode(g.postalCode);
          if (streetParts.length || g.city || g.postalCode) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } else {
            setSignUpError(GEO_MESSAGES.noAddress);
          }
        } else {
          setSignUpError(GEO_MESSAGES.noAddress);
        }
      }
    } catch (e: unknown) {
      setSignUpError(geolocationErrorMessage(e));
    } finally {
      setFetchingLocation(false);
    }
  }

  function renderPracticeInfo() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.inputGroup}>
          <View style={styles.inputWrapper}>
            <Ionicons name="business-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={practiceName}
              onChangeText={(t) => { setPracticeName(t); setSignUpError(null); }}
              placeholder="Practice Name"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="words"
              testID="practice-name"
            />
          </View>

          <View style={styles.inputWrapper}>
            <Ionicons name="person-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={doctorName}
              onChangeText={(t) => { setDoctorName(t); setSignUpError(null); }}
              placeholder="Doctor Name"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="words"
              testID="doctor-name"
            />
          </View>

          <View style={styles.inputWrapper}>
            <Ionicons name="location-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={streetAddress}
              onChangeText={(t) => { setStreetAddress(t); setSignUpError(null); }}
              placeholder="Street Address"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="words"
              textContentType="oneTimeCode"
              autoComplete="off"
              testID="street-address"
            />
            <Pressable
              onPress={fetchLocationAddress}
              disabled={fetchingLocation}
              style={{ padding: 6, marginLeft: 4 }}
              testID="location-btn"
            >
              {fetchingLocation ? (
                <ActivityIndicator size={16} color="rgba(255,255,255,0.6)" />
              ) : (
                <Ionicons name="navigate" size={18} color="#4A90D9" />
              )}
            </Pressable>
          </View>

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={[styles.inputWrapper, { flex: 1 }]}>
              <TextInput
                style={styles.input}
                value={city}
                onChangeText={(t) => { setCity(t); setSignUpError(null); }}
                placeholder="City"
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="words"
                testID="city"
              />
            </View>
            <View style={[styles.inputWrapper, { flex: 0.55 }]}>
              <TextInput
                style={styles.input}
                value={state}
                onChangeText={(t) => { setState(t.toUpperCase()); setSignUpError(null); }}
                placeholder="State"
                placeholderTextColor="rgba(255,255,255,0.3)"
                autoCapitalize="characters"
                maxLength={2}
                testID="state"
              />
            </View>
            <View style={[styles.inputWrapper, { flex: 0.6 }]}>
              <TextInput
                style={styles.input}
                value={zipCode}
                onChangeText={(t) => { setZipCode(t); setSignUpError(null); }}
                placeholder="Zip Code"
                placeholderTextColor="rgba(255,255,255,0.3)"
                keyboardType="number-pad"
                testID="zip-code"
              />
            </View>
          </View>

          <View style={styles.inputWrapper}>
            <Ionicons name="call-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={practicePhone}
              onChangeText={(t) => { setPracticePhone(t); setSignUpError(null); }}
              placeholder="Office Number"
              placeholderTextColor="rgba(255,255,255,0.3)"
              keyboardType="phone-pad"
              textContentType="oneTimeCode"
              autoComplete="off"
              testID="practice-phone"
            />
          </View>
        </View>

        <Pressable
          onPress={async () => {
            if (!practiceName.trim() || !doctorName.trim() || !streetAddress.trim() || !city.trim() || !state.trim() || !zipCode.trim() || !practicePhone.trim()) {
              setSignUpError("All fields are required.");
              return;
            }
            setSignUpError(null);
            setMatchLookupLoading(true);
            try {
              const params = new URLSearchParams({
                phone: practicePhone.trim(),
                city: city.trim(),
              });
              const res = await apiRequest("GET", `/api/auth/lookup-provider-matches?${params}`);
              const data = await res.json();
              const matches: ProviderMatchItem[] = Array.isArray(data?.data?.matches) ? data.data.matches : [];
              setProviderMatches(matches);
              if (matches.length > 0) {
                setMatchLookupLoading(false);
                setSignUpStep("provider_match");
                return;
              }
            } catch {
              // Lookup failure is non-blocking — proceed normally
            }
            setMatchLookupLoading(false);
            sendEmailCode();
          }}
          disabled={codeSending || matchLookupLoading}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (codeSending || matchLookupLoading) && { opacity: 0.6 }]}
          testID="practice-info-next-btn"
        >
          {(codeSending || matchLookupLoading) ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Text style={styles.loginBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={20} color="#FFF" />
            </>
          )}
        </Pressable>
      </View>
    );
  }

  function renderPhoneContactName() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.inputWrapper}>
          <Ionicons name="person-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={phoneContactName}
            onChangeText={(t) => { setPhoneContactName(t); setSignUpError(null); }}
            placeholder="Full name of phone contact"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCorrect={false}
            testID="phone-contact-name"
          />
        </View>

        <Text style={styles.helperText}>
          Who should we text for case updates?
        </Text>

        <Pressable
          onPress={() => {
            if (!phoneContactName.trim()) {
              setSignUpError("Please enter a contact name.");
              return;
            }
            setSignUpError(null);
            // Matched providers and practice joiners don't pick a role — go straight to hipaa
            setSignUpStep(selectedMatchOrgId || providerIntent === "join" ? "hipaa_disclaimer" : "join_group");
          }}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
          testID="phone-contact-next-btn"
        >
          <Text style={styles.loginBtnText}>Continue</Text>
          <Ionicons name="arrow-forward" size={20} color="#FFF" />
        </Pressable>
      </View>
    );
  }

  function renderProviderMatch() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <Text style={{ color: "rgba(255,255,255,0.75)", fontSize: 14, lineHeight: 20, marginBottom: 8 }}>
          We found {providerMatches.length === 1 ? "a practice" : "practices"} that match{providerMatches.length === 1 ? "es" : ""} your phone number and city. Is one of these your practice?
        </Text>

        {providerMatches.map((match) => (
          <Pressable
            key={match.orgId}
            onPress={() => {
              if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSelectedMatchOrgId(match.orgId);
              setSignUpError(null);
              sendEmailCode();
            }}
            style={({ pressed }) => [
              {
                paddingVertical: 14,
                paddingHorizontal: 16,
                borderRadius: 10,
                backgroundColor: pressed ? "rgba(74,144,217,0.18)" : "rgba(255,255,255,0.07)",
                borderWidth: 1,
                borderColor: "rgba(74,144,217,0.4)",
                gap: 4,
              },
            ]}
            testID={`provider-match-card-${match.orgId}`}
          >
            <Text style={{ color: "#FFF", fontSize: 15, fontWeight: "700" }}>{match.practiceName}</Text>
            {match.labName && (
              <Text style={{ color: "rgba(255,255,255,0.6)", fontSize: 12 }}>Lab: {match.labName}</Text>
            )}
            {(match.city || match.state) && (
              <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 12 }}>
                {[match.city, match.state].filter(Boolean).join(", ")}
              </Text>
            )}
            {match.platformAccountNumber && (
              <Text style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, fontFamily: "monospace" }}>
                #{formatAccountNumberForDisplay(match.platformAccountNumber)}
              </Text>
            )}
          </Pressable>
        ))}

        <Pressable
          onPress={() => {
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSelectedMatchOrgId(null);
            setSignUpError(null);
            sendEmailCode();
          }}
          style={({ pressed }) => [
            {
              paddingVertical: 12,
              paddingHorizontal: 16,
              borderRadius: 10,
              backgroundColor: pressed ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)",
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.15)",
              alignItems: "center",
            },
          ]}
          testID="provider-match-none"
        >
          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 14 }}>None of these — create a new practice</Text>
        </Pressable>
      </View>
    );
  }

  function renderJoinGroup() {
    if (userType === "provider") return renderPartnerLabs();
    const isLabUser = userType === "lab";
    const searchTargetType = isLabUser ? "provider" : "lab";
    const searchLabel = isLabUser ? "Search for a dental provider..." : "Search for your lab...";
    const searchDescription = isLabUser
      ? "Start typing to find a dental provider. Select a provider to send a connection request. They will need to accept before being linked to your lab."
      : "Start typing to find your lab. Select the correct lab to send a connection request.";
    const noResultsText = isLabUser ? "No matching providers found" : "No matching labs found";
    const duplicateText = isLabUser ? "You already have a pending request to this provider." : "You already have a pending request to this lab.";

    const labSearchText = joinGroupAdminUsername;
    const matchingResults = labSearchText.trim().length > 0
      ? registeredUsers.filter(u =>
          u.userType === searchTargetType &&
          u.role === "admin" &&
          (
            (u.username && u.username.toLowerCase().includes(labSearchText.trim().toLowerCase())) ||
            (u.practiceName && u.practiceName.toLowerCase().includes(labSearchText.trim().toLowerCase())) ||
            (u.doctorName && u.doctorName.toLowerCase().includes(labSearchText.trim().toLowerCase()))
          )
        )
      : [];

    const handleSelectTarget = async (target: typeof registeredUsers[0]) => {
      const selectedUsername = target.username;
      setJoinGroupAdminUsername(selectedUsername);
      try {
        const stored = await AsyncStorage.getItem("@drivesync_group_join_requests");
        const existing: GroupJoinRequest[] = stored ? JSON.parse(stored) : [];
        const alreadyPending = existing.find(
          r => r.requestingUsername.toLowerCase() === signUpUsername.trim().toLowerCase()
            && r.targetAdminUsername.toLowerCase() === selectedUsername.toLowerCase()
            && r.status === "pending"
        );
        if (alreadyPending) {
          setSignUpError(duplicateText);
          return;
        }
        const requestMessage = isLabUser
          ? `${signUpUsername.trim()} (Lab) would like to connect with your practice.`
          : `${signUpUsername.trim()} would like to connect with your lab.`;
        const request: GroupJoinRequest = {
          id: generateId(),
          requestingUsername: signUpUsername.trim(),
          targetAdminUsername: selectedUsername,
          message: requestMessage,
          status: "pending",
          createdAt: Date.now(),
        };
        const updated = [...existing, request];
        await AsyncStorage.setItem("@drivesync_group_join_requests", JSON.stringify(updated));
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setJoinGroupSent(true);
      } catch {
        setSignUpError("Could not send request. Please try again.");
      }
    };

    return (
      <View style={styles.formSection}>
        <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", lineHeight: 20, marginBottom: 20 }}>
          {searchDescription}
        </Text>

        {!joinGroupSent ? (
          <>
            <View style={[styles.inputGroup, { marginBottom: 0 }]}>
              <View style={styles.inputWrapper}>
                <Ionicons name="search" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  placeholder={searchLabel}
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={joinGroupAdminUsername}
                  onChangeText={(t) => { setJoinGroupAdminUsername(t); setJoinGroupSent(false); setSignUpError(null); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>

            {matchingResults.length > 0 && (
              <View style={{ marginTop: 4, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.08)", borderWidth: 1, borderColor: "rgba(255,255,255,0.1)", maxHeight: 200, overflow: "hidden" }}>
                <ScrollView
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  keyboardDismissMode={scrollKeyboardDismissMode}
                >
                  {matchingResults.map((result, index) => (
                    <Pressable
                      key={result.username + index}
                      onPress={() => handleSelectTarget(result)}
                      style={({ pressed }) => [
                        { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: index < matchingResults.length - 1 ? 1 : 0, borderBottomColor: "rgba(255,255,255,0.06)" },
                        pressed && { backgroundColor: "rgba(255,255,255,0.1)" },
                      ]}
                    >
                      <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>
                        {isLabUser ? (result.doctorName || result.practiceName || result.username) : (result.practiceName || result.username)}
                      </Text>
                      {result.practiceAddress ? (
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                          {result.practiceAddress}
                        </Text>
                      ) : null}
                      {result.practicePhone ? (
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                          {result.practicePhone}
                        </Text>
                      ) : null}
                      {isLabUser && result.practiceName && result.doctorName ? (
                        <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
                          {result.practiceName}
                        </Text>
                      ) : null}
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

            {labSearchText.trim().length > 0 && matchingResults.length === 0 && (
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.4)", marginTop: 8, textAlign: "center" }}>
                {noResultsText}
              </Text>
            )}
          </>
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 20 }}>
            <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "rgba(16,185,129,0.2)", justifyContent: "center", alignItems: "center", marginBottom: 12 }}>
              <Ionicons name="checkmark-circle" size={36} color="#10B981" />
            </View>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF", marginBottom: 4 }}>Request Sent</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center" }}>
              {isLabUser
                ? `Your connection request has been sent to ${joinGroupAdminUsername}. They will need to accept before being linked to your lab.`
                : `Your connection request has been sent to ${joinGroupAdminUsername}. You'll be notified when they respond.`
              }
            </Text>
          </View>
        )}

        <Pressable
          onPress={() => {
            setSignUpStep("hipaa_disclaimer");
          }}
          style={({ pressed }) => [
            {
              marginTop: 16,
              alignItems: "center",
              paddingVertical: 14,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.15)",
            },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={{ fontSize: 15, fontFamily: "Inter_600SemiBold", color: "rgba(255,255,255,0.7)" }}>
            {joinGroupSent ? "Continue" : "Skip for now"}
          </Text>
        </Pressable>

        {signUpError && (
          <View style={[styles.errorBanner, { marginTop: 12 }]}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}
      </View>
    );
  }

  function renderPartnerLabs() {
    return (
      <View style={styles.formSection}>
        <Text style={styles.fieldLabel}>Select one or multiple labs</Text>
        <Text style={styles.optionCardDesc}>Optional. Each lab admin must approve your request before you have access.</Text>
        <Text accessibilityLiveRegion="polite" style={styles.fieldLabel}>{partnerLabs.length} labs selected</Text>
        <View style={styles.inputWrapper}>
          <Ionicons name="search" size={18} color={Colors.light.textSecondary} style={styles.inputIcon} />
          <TextInput style={styles.input} placeholder="Search for your lab..." placeholderTextColor={Colors.light.textSecondary}
            value={partnerSearch} onChangeText={setPartnerSearch} autoCapitalize="none" autoCorrect={false} testID="partner-lab-search" />
        </View>
        {partnerLabs.map((lab) => (
          <View key={lab.selectionKey ?? lab.id} style={styles.inputWrapper}>
            <Text style={[styles.fieldLabel, { flex: 1 }]}>{lab.displayName}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${lab.displayName}`}
              testID={`remove-partner-${lab.selectionKey ?? lab.id}`}
              onPress={() => { setPartnersConfirmed(false); setPartnerLabs((current) => current.filter((item) => (item.selectionKey ?? item.id) !== (lab.selectionKey ?? lab.id))); }}>
              <Text style={styles.fieldLabel}>Remove</Text>
            </Pressable>
          </View>
        ))}
        {partnerLoading ? <ActivityIndicator color={Colors.light.tint} /> : (
          <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled keyboardShouldPersistTaps="handled" keyboardDismissMode={scrollKeyboardDismissMode}>
            {partnerResults.map((lab) => {
              const selected = partnerLabs.some((item) => (item.selectionKey ?? item.id) === (lab.selectionKey ?? lab.id));
              return (
                <Pressable key={lab.id} accessibilityRole="checkbox" accessibilityLabel={lab.displayName} accessibilityState={{ checked: selected, disabled: signUpLoading }}
                  disabled={signUpLoading}
                  testID={`partner-result-${lab.selectionKey ?? lab.id}`}
                  style={[styles.optionCard, { flexDirection: "row", alignItems: "center", gap: 12 }, selected && styles.optionCardSelected]}
                  onPress={() => {
                    if (signUpLoading) return;
                    setPartnersConfirmed(false);
                    if (selected) {
                      setPartnerLabs((current) => current.filter((item) => (item.selectionKey ?? item.id) !== (lab.selectionKey ?? lab.id)));
                      return;
                    }
                    if (partnerLabs.length >= 20) { setSignUpError("Select up to 20 partner labs."); return; }
                    setSignUpError(null);
                    setPartnerLabs((current) => [...current, lab]);
                  }}>
                  <Ionicons name={selected ? "checkbox" : "square-outline"} size={24} color={selected ? Colors.light.tint : Colors.light.textSecondary} />
                  <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>{lab.displayName}{selected ? " — Selected" : ""}</Text>
                  <Text style={styles.optionCardDesc}>{[lab.city, lab.state].filter(Boolean).join(", ")}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
        {partnerSearchError && <Text style={styles.errorText}>{partnerSearchError}</Text>}
        {!partnerLoading && !partnerSearchError && partnerResults.length === 0 && (
          <Text style={styles.optionCardDesc}>{partnerSearch.trim().length >= 2 ? "No matching labs found" : "Type to search for labs…"}</Text>
        )}
        {signUpError && <Text style={styles.errorText}>{signUpError}</Text>}
      </View>
    );
  }

  function renderHipaaDisclaimer() {
    const isEmailConflict = !!signUpError && signUpError.includes("email already exists");
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}
        {isEmailConflict && (
          <Pressable
            onPress={() => { setSignUpStep("credentials"); setSignUpError(null); }}
            style={({ pressed }) => [{ alignSelf: "center", marginTop: 8, opacity: pressed ? 0.6 : 1 }]}
            testID="hipaa-fix-email-link"
          >
            <Text style={{ color: "#60A5FA", fontSize: 14, fontFamily: "Inter_500Medium", textDecorationLine: "underline" }}>
              Go back to fix your email
            </Text>
          </Pressable>
        )}

        <View style={styles.hipaaCard}>
          <ScrollView
            style={styles.hipaaScroll}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={scrollKeyboardDismissMode}
          >
            <Text style={styles.hipaaTitle}>HIPAA COMPLIANCE NOTICE</Text>
            <Text style={styles.hipaaBody}>
              All information within this application is considered HIPAA compliant and is handled in accordance with applicable privacy regulations.
            </Text>

            <Text style={styles.hipaaTitle}>AUTHORIZATION & LIABILITY</Text>
            <Text style={styles.hipaaBody}>
              By creating an account and using this application, you acknowledge that:
            </Text>
            <Text style={styles.hipaaBody}>
              1. Any instruction provided through this application to the dental laboratory will be carried forth with the assumption that the user has full authority to make changes to any case.
            </Text>
            <Text style={styles.hipaaBody}>
              2. The dental laboratory is relieved of all responsibilities and consequences for decisions made or changes made to cases from this application.
            </Text>
            <Text style={styles.hipaaBody}>
              3. You are solely responsible for the accuracy of all information and instructions submitted through this application.
            </Text>
            <Text style={[styles.hipaaBody, { marginTop: 12 }]}>
              By proceeding, you agree to these terms and conditions.
            </Text>
          </ScrollView>
        </View>

        <Pressable
          onPress={() => {
            setHipaaAccepted(!hipaaAccepted);
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }}
          style={styles.hipaaCheckRow}
          testID="hipaa-checkbox"
        >
          <View style={[styles.hipaaCheckbox, hipaaAccepted && styles.hipaaCheckboxChecked]}>
            {hipaaAccepted && <Ionicons name="checkmark" size={16} color="#FFF" />}
          </View>
          <Text style={styles.hipaaCheckLabel}>I have read and agree to the terms above</Text>
        </Pressable>

        <Pressable
          onPress={completeRegistration}
          disabled={!hipaaAccepted || signUpLoading}
          style={({ pressed }) => [
            styles.loginBtn,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
            (!hipaaAccepted || signUpLoading) && { opacity: 0.6 },
          ]}
          testID="hipaa-accept-btn"
        >
          {signUpLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Ionicons name="shield-checkmark" size={20} color="#FFF" />
              <Text style={styles.loginBtnText}>Accept & Create Account</Text>
            </>
          )}
        </Pressable>

        <Text style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, fontFamily: "Inter_400Regular", textAlign: "center", marginTop: 16, lineHeight: 18 }}>
          By creating an account, you agree to our{" "}
          <Text onPress={() => router.push("/terms-of-service")} style={{ color: "#60A5FA", textDecorationLine: "underline" }}>Terms of Service</Text>
          {" "}and{" "}
          <Text onPress={() => router.push("/privacy-policy")} style={{ color: "#60A5FA", textDecorationLine: "underline" }}>Privacy Policy</Text>.
        </Text>
      </View>
    );
  }

  function renderWelcome() {
    return (
      <View style={styles.formSection}>
        <Text style={{ ...Typography.body, color: "rgba(255,255,255,0.75)", lineHeight: 22, marginBottom: 16 }}>
          LabTrax is currently undergoing rapid development. We ship frequent feature updates and continuous improvements every week — and your feedback directly shapes what we build next.
        </Text>

        <View style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.12)",
          backgroundColor: "rgba(255,255,255,0.06)",
          paddingHorizontal: 16,
          paddingVertical: 14,
          marginBottom: 12,
          gap: 8,
        }}>
          <Text style={{ ...Typography.bodySemibold, color: "rgba(255,255,255,0.9)", marginBottom: 4 }}>
            What&apos;s available now:
          </Text>
          {[
            "Case tracking from intake to delivery",
            "Invoice generation and payment recording",
            "Provider and lab organization management",
            "Case media uploads and attachments",
          ].map((item) => (
            <View key={item} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <Text style={{ color: Colors.light.tint, marginTop: 1 }}>•</Text>
              <Text style={{ ...Typography.body, color: "rgba(255,255,255,0.7)", flex: 1 }}>{item}</Text>
            </View>
          ))}
        </View>

        <View style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: "rgba(255,255,255,0.10)",
          backgroundColor: "rgba(255,255,255,0.04)",
          paddingHorizontal: 16,
          paddingVertical: 14,
          marginBottom: 16,
          gap: 8,
        }}>
          <Text style={{ ...Typography.bodySemibold, color: "rgba(255,255,255,0.9)", marginBottom: 4 }}>
            Expanding soon:
          </Text>
          {[
            "Provider patient portal",
            "AI-powered Rx parsing and workflows",
            "Production tracking and station scanning",
            "Automated case status notifications",
            "Mobile companion app enhancements",
          ].map((item) => (
            <View key={item} style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
              <Text style={{ color: Colors.light.tint, marginTop: 1 }}>→</Text>
              <Text style={{ ...Typography.body, color: "rgba(255,255,255,0.65)", flex: 1 }}>{item}</Text>
            </View>
          ))}
        </View>

        <View style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: "rgba(99,179,237,0.4)",
          backgroundColor: "rgba(99,179,237,0.1)",
          paddingHorizontal: 16,
          paddingVertical: 14,
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 10,
          marginBottom: 24,
        }}>
          <Text style={{ fontSize: 18, lineHeight: 22 }}>🎁</Text>
          <Text style={{ ...Typography.body, color: "rgba(255,255,255,0.9)", flex: 1 }}>
            <Text style={{ fontWeight: "700" }}>Your first 30 days are completely free</Text>
            {" "}— no credit card required to get started.
          </Text>
        </View>

      </View>
    );
  }

  function renderCredentialsStep() {
    return (
      <View style={[styles.formSection, styles.credentialsFormSection]}>
        {signUpError && (
          <View style={[styles.errorBanner, styles.credentialsErrorBanner]}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.credentialsFieldGroup}>
          <Text style={styles.credentialsFieldLabel}>Username</Text>
          <View style={[styles.inputWrapper, styles.credentialsInputWrapper]}>
            <Ionicons name="person-outline" size={17} color="#71839A" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, styles.credentialsInput]}
              value={signUpUsername}
              onChangeText={(t) => { setSignUpUsername(t); setSignUpError(null); }}
              placeholder="Enter a username"
              placeholderTextColor="#91A1B5"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              accessibilityLabel="Username"
              maxLength={12}
              editable={!signUpLoading}
              testID="signup-username"
            />
          </View>
          <Text style={styles.credentialsFieldHint}>3–12 characters: letters, numbers, or underscores.</Text>
        </View>

        <View style={styles.credentialsFieldGroup}>
          <Text style={styles.credentialsFieldLabel}>Email</Text>
          <View style={[styles.inputWrapper, styles.credentialsInputWrapper]}>
            <Ionicons name="mail-outline" size={17} color="#71839A" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, styles.credentialsInput]}
              value={signUpEmail}
              onChangeText={(t) => { setSignUpEmail(t); setSignUpError(null); setEmailConflictError(null); }}
              onBlur={handleEmailBlur}
              placeholder="you@example.com"
              placeholderTextColor="#91A1B5"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="emailAddress"
              autoComplete="email"
              accessibilityLabel="Email"
              editable={!signUpLoading}
              testID="signup-email"
            />
            {emailCheckLoading && (
              <ActivityIndicator size="small" color="#2878C8" style={{ marginRight: 8 }} />
            )}
          </View>
          {emailConflictError && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4, paddingTop: 4 }}>
              <Ionicons name="alert-circle" size={14} color={Colors.light.error} />
              <Text style={{ color: Colors.light.error, fontSize: 12, fontFamily: "Inter_400Regular", flex: 1 }} testID="email-conflict-error">
                {emailConflictError}
              </Text>
            </View>
          )}
          {isSharedTestEmail(signUpEmail) && (
            <View style={styles.credentialsSharedEmail} testID="shared-email-signup-guidance">
              <Ionicons name="information-circle" size={18} color="#398DDD" />
              <Text style={styles.credentialsSharedEmailText}>
                This shared test email can be used for multiple accounts. Sign in to each with its unique username; email sign-in can’t distinguish them.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.credentialsFieldGroup}>
          <Text style={styles.credentialsFieldLabel}>Password</Text>
          <View style={[styles.inputWrapper, styles.credentialsInputWrapper]}>
            <Ionicons name="lock-closed-outline" size={17} color="#71839A" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, styles.credentialsInput, { flex: 1 }]}
              value={signUpPassword}
              onChangeText={(t) => { setSignUpPassword(t); setSignUpError(null); }}
              placeholder="Create a password"
              placeholderTextColor="#91A1B5"
              secureTextEntry={!showSignUpPassword}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="new-password"
              accessibilityLabel="Password"
              editable={!signUpLoading}
              testID="signup-password"
            />
            <Pressable
              onPress={() => setShowSignUpPassword(!showSignUpPassword)}
              style={[styles.eyeBtn, styles.credentialsEyeBtn]}
              accessibilityRole="button"
              accessibilityLabel={showSignUpPassword ? "Hide password" : "Show password"}
              accessibilityState={{ checked: showSignUpPassword }}
              testID="signup-password-visibility"
            >
              <Ionicons name={showSignUpPassword ? "eye-off-outline" : "eye-outline"} size={19} color="#60758E" />
            </Pressable>
          </View>

          <View style={[styles.pwRequirements, styles.credentialsPwRequirements]} testID="signup-password-requirements">
              {[
                { label: "8+ characters", met: signUpPassword.length >= 8 },
                { label: "Uppercase letter", met: /[A-Z]/.test(signUpPassword) },
                { label: "Lowercase letter", met: /[a-z]/.test(signUpPassword) },
                { label: "Special character", met: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(signUpPassword) },
              ].map((req) => (
                <View key={req.label} style={styles.pwReqRow}>
                  <Ionicons
                    name={req.met ? "checkmark-circle" : "ellipse-outline"}
                    size={14}
                    color={req.met ? "#188B6A" : "#97A7B9"}
                  />
                  <Text style={[styles.pwReqText, styles.credentialsPwReqText, req.met && styles.pwReqMet]}>{req.label}</Text>
                </View>
              ))}
            </View>
        </View>

        <View style={styles.credentialsFieldGroup}>
          <Text style={styles.credentialsFieldLabel}>Confirm Password</Text>
          <View style={[styles.inputWrapper, styles.credentialsInputWrapper]}>
            <Ionicons name="lock-closed-outline" size={17} color="#71839A" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, styles.credentialsInput, { flex: 1 }]}
              value={signUpConfirmPassword}
              onChangeText={(t) => { setSignUpConfirmPassword(t); setSignUpError(null); }}
              placeholder="Re-enter your password"
              placeholderTextColor="#91A1B5"
              secureTextEntry={!showSignUpPassword}
              autoCapitalize="none"
              textContentType="newPassword"
              autoComplete="new-password"
              accessibilityLabel="Confirm Password"
              editable={!signUpLoading}
              testID="signup-confirm-password"
            />
          </View>
        </View>

        <Pressable
          onPress={handleCredentialsNext}
          disabled={signUpLoading || emailCheckLoading || !!emailConflictError}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (signUpLoading || emailCheckLoading || !!emailConflictError) && { opacity: 0.6 }]}
          testID="signup-next-btn"
        >
          {signUpLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Text style={styles.loginBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={20} color="#FFF" />
            </>
          )}
        </Pressable>
      </View>
    );
  }

  function renderUpdatesOptIn() {
    return (
      <View style={styles.formSection}>
        <View style={styles.optInCard}>
          <View style={styles.optInIconRow}>
            <LinearGradient
              colors={[Colors.light.tint, "#3B82F6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optInIcon}
            >
              <Ionicons name="chatbubbles" size={28} color="#FFF" />
            </LinearGradient>
          </View>
          <Text style={styles.optInTitle}>Case Updates & Messaging</Text>
          <Text style={styles.optInDesc}>
            Would you like to receive case updates and message the lab directly via text?
          </Text>

          <View style={styles.optInBtns}>
            <Pressable
              onPress={() => handleUpdatesChoice(true)}
              style={({ pressed }) => [styles.optInYes, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
              testID="updates-yes-btn"
            >
              <Ionicons name="checkmark" size={20} color="#FFF" />
              <Text style={styles.optInYesText}>Yes, sign me up</Text>
            </Pressable>

            <Pressable
              onPress={() => handleUpdatesChoice(false)}
              style={({ pressed }) => [styles.optInNo, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
              testID="updates-no-btn"
            >
              <Text style={styles.optInNoText}>No thanks</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  function renderPhoneEntry() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.inputWrapper}>
          <Ionicons name="call-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
          <TextInput
            style={styles.input}
            value={signUpPhone}
            onChangeText={(t) => { setSignUpPhone(t); setSignUpError(null); }}
            placeholder="Phone Number"
            placeholderTextColor="rgba(255,255,255,0.3)"
            keyboardType="phone-pad"
            editable={!codeSending}
            testID="signup-phone"
          />
        </View>

        <Text style={styles.helperText}>
          We'll send a 6-digit code to verify your number.
        </Text>

        <Pressable
          onPress={handlePhoneNext}
          disabled={codeSending}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, codeSending && { opacity: 0.6 }]}
          testID="send-phone-code-btn"
        >
          {codeSending ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Ionicons name="paper-plane" size={18} color="#FFF" />
              <Text style={styles.loginBtnText}>Send Code</Text>
            </>
          )}
        </Pressable>
      </View>
    );
  }

  function renderPhoneVerify() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.verifyInfo}>
          <Ionicons name="phone-portrait-outline" size={20} color="rgba(255,255,255,0.6)" />
          <Text style={styles.verifyInfoText}>
            Code sent to {signUpPhone}
          </Text>
        </View>

        {demoPhoneCode && (
          <View style={styles.demoCodeBanner}>
            <Ionicons name="key" size={16} color="#F59E0B" />
            <Text style={styles.demoCodeLabel}>Demo Code:</Text>
            <Text style={styles.demoCodeValue}>{demoPhoneCode}</Text>
          </View>
        )}

        <View style={styles.codeInputRow}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <TextInput
              key={i}
              ref={(r) => { codeInputRefs.current[i] = r; }}
              style={[styles.codeBox, phoneCode[i] ? styles.codeBoxFilled : null]}
              value={phoneCode[i] || ""}
              onChangeText={(t) => {
                const digit = t.replace(/\D/g, "").slice(-1);
                const newCode = phoneCode.split("");
                newCode[i] = digit;
                const joined = newCode.join("").slice(0, 6);
                setPhoneCode(joined);
                setSignUpError(null);
                if (digit && i < 5) {
                  codeInputRefs.current[i + 1]?.focus();
                }
              }}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === "Backspace" && !phoneCode[i] && i > 0) {
                  const newCode = phoneCode.split("");
                  newCode[i - 1] = "";
                  setPhoneCode(newCode.join(""));
                  codeInputRefs.current[i - 1]?.focus();
                }
              }}
              keyboardType="number-pad"
              maxLength={1}
              editable={!signUpLoading}
              testID={`phone-code-${i}`}
            />
          ))}
        </View>

        <Pressable
          onPress={handleVerifyPhoneCode}
          disabled={signUpLoading || phoneCode.length !== 6}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (signUpLoading || phoneCode.length !== 6) && { opacity: 0.6 }]}
          testID="verify-phone-btn"
        >
          {signUpLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color="#FFF" />
              <Text style={styles.loginBtnText}>Verify</Text>
            </>
          )}
        </Pressable>

        <Pressable
          onPress={sendPhoneCode}
          disabled={codeResendTimer > 0 || codeSending}
          style={({ pressed }) => [styles.resendBtn, pressed && { opacity: 0.7 }]}
          testID="resend-phone-code-btn"
        >
          <Text style={[styles.resendText, codeResendTimer > 0 && { opacity: 0.4 }]}>
            {codeResendTimer > 0 ? `Resend code in ${codeResendTimer}s` : "Resend Code"}
          </Text>
        </Pressable>
      </View>
    );
  }

  function renderEmailVerify() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.verifyInfo}>
          <Ionicons name="mail-outline" size={20} color="rgba(255,255,255,0.6)" />
          <Text style={styles.verifyInfoText}>
            Code sent to {signUpEmail}
          </Text>
        </View>

        {demoEmailCode && (
          <View style={styles.demoCodeBanner}>
            <Ionicons name="key" size={16} color="#F59E0B" />
            <Text style={styles.demoCodeLabel}>Demo Code:</Text>
            <Text style={styles.demoCodeValue}>{demoEmailCode}</Text>
          </View>
        )}

        <View style={styles.codeInputRow}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <TextInput
              key={i}
              ref={(r) => { codeInputRefs.current[i + 6] = r; }}
              style={[styles.codeBox, emailCode[i] ? styles.codeBoxFilled : null]}
              value={emailCode[i] || ""}
              onChangeText={(t) => {
                const digit = t.replace(/\D/g, "").slice(-1);
                const newCode = emailCode.split("");
                newCode[i] = digit;
                const joined = newCode.join("").slice(0, 6);
                setEmailCode(joined);
                setSignUpError(null);
                if (digit && i < 5) {
                  codeInputRefs.current[i + 7]?.focus();
                }
              }}
              onKeyPress={(e) => {
                if (e.nativeEvent.key === "Backspace" && !emailCode[i] && i > 0) {
                  const newCode = emailCode.split("");
                  newCode[i - 1] = "";
                  setEmailCode(newCode.join(""));
                  codeInputRefs.current[i + 5]?.focus();
                }
              }}
              keyboardType="number-pad"
              maxLength={1}
              editable={!signUpLoading}
              testID={`email-code-${i}`}
            />
          ))}
        </View>

        <Pressable
          onPress={handleVerifyEmailCode}
          disabled={signUpLoading || emailCode.length !== 6}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (signUpLoading || emailCode.length !== 6) && { opacity: 0.6 }]}
          testID="verify-email-btn"
        >
          {signUpLoading ? (
            <ActivityIndicator size="small" color="#FFF" />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={20} color="#FFF" />
              <Text style={styles.loginBtnText}>Verify</Text>
            </>
          )}
        </Pressable>

        <Pressable
          onPress={sendEmailCode}
          disabled={codeResendTimer > 0 || codeSending}
          style={({ pressed }) => [styles.resendBtn, pressed && { opacity: 0.7 }]}
          testID="resend-email-code-btn"
        >
          <Text style={[styles.resendText, codeResendTimer > 0 && { opacity: 0.4 }]}>
            {codeResendTimer > 0 ? `Resend code in ${codeResendTimer}s` : "Resend Code"}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <DismissKeyboardView
      style={styles.container}
      testID="login-screen-keyboard-dismiss"
    >
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.loginContent,
            {
              paddingTop: 0,
              paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={scrollKeyboardDismissMode}
          showsVerticalScrollIndicator={false}
          testID="login-scroll"
        >
          <View
            style={[
              styles.signInBrandHeader,
              {
                paddingTop: Platform.OS === "web" ? 67 + 20 : insets.top + 20,
              },
            ]}
            testID="login-brand-header"
          >
            <View style={styles.signInBrandRow}>
              <Image
                source={require("@/assets/images/icon.png")}
                style={styles.signInBrandIcon}
                resizeMode="contain"
              />
              <View style={styles.signInBrandCopy}>
                <Pressable
                  onPress={() => {
                    const next = diagTapCount + 1;
                    setDiagTapCount(next);
                    if (next >= 5) {
                      const apiUrl = getApiUrl();
                      const domain = process.env.EXPO_PUBLIC_DOMAIN || "(not set)";
                      Alert.alert("Diagnostics", `API: ${apiUrl}\nDomain env: ${domain}\nPlatform: ${Platform.OS}\nBuild: 51`);
                      setDiagTapCount(0);
                    }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="LabTrax"
                  accessibilityHint="Tap five times to open diagnostics."
                >
                  <Text style={styles.signInBrandName}>LabTrax</Text>
                </Pressable>
                <Text style={styles.signInBrandTagline}>Built for dental professionals</Text>
              </View>
            </View>
            <View style={styles.signInBrandRule}>
              <View style={styles.signInBrandRuleLine} />
              <Text style={styles.signInBrandCaption}>Your cases. Your workflow. Connected.</Text>
            </View>
          </View>

          <View style={[styles.formSection, styles.signInCard]} testID="login-card">
            <View style={styles.signInCardHeading}>
              <Text style={styles.signInHeading}>Welcome back</Text>
              <Text style={styles.signInSubheading}>Sign in to your LabTrax account.</Text>
            </View>
            {error && (
              <View style={styles.signInErrorBanner} accessibilityRole="alert">
                <Ionicons name="alert-circle" size={17} color={Colors.light.errorText} />
                <Text style={styles.signInErrorText}>{error}</Text>
              </View>
            )}

            {twoFactorPendingToken ? (
              <View style={{ gap: 12 }}>
                <View style={{ alignItems: "center", marginBottom: 4 }}>
                  <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: Colors.light.infoLight, alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                    <Ionicons name="shield-checkmark" size={26} color={Colors.light.tint} />
                  </View>
                  <Text style={{ fontSize: 17, fontFamily: "Inter_600SemiBold", color: Colors.light.text, marginBottom: 4 }}>Two-Factor Verification</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary, textAlign: "center" }}>
                    {useBackupCode
                      ? "Enter one of your saved backup codes."
                      : "Enter the 6-digit code from your authenticator app."}
                  </Text>
                </View>
                <View style={styles.signInInputWrapper}>
                  <Ionicons name="keypad-outline" size={18} color={Colors.light.textTertiary} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.signInInput, { letterSpacing: 4, textAlign: "center" }]}
                    value={totpCode}
                    onChangeText={(t) => {
                      setTotpCode(useBackupCode ? t.toUpperCase() : t.replace(/\D/g, "").slice(0, 6));
                      setError(null);
                    }}
                    placeholder={useBackupCode ? "BACKUP CODE" : "000000"}
                    placeholderTextColor={Colors.light.textTertiary}
                    keyboardType={useBackupCode ? "default" : "number-pad"}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={useBackupCode ? 20 : 6}
                    autoFocus
                  />
                </View>
                {/* Trust this device checkbox */}
                <Pressable
                  onPress={() => setTrustDevice(!trustDevice)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 }}
                >
                  <View style={{
                    width: 22, height: 22, borderRadius: 5,
                    borderWidth: 2, borderColor: trustDevice ? Colors.light.tint : Colors.light.border,
                    backgroundColor: trustDevice ? Colors.light.tint : "transparent",
                    alignItems: "center", justifyContent: "center",
                  }}>
                    {trustDevice && <Ionicons name="checkmark" size={14} color="#FFF" />}
                  </View>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: Colors.light.textSecondary }}>
                    Trust this device for 30 days
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleTwoFactorChallenge}
                  disabled={isChallenging || !totpCode.trim()}
                  style={({ pressed }) => [styles.signInPrimaryBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (isChallenging || !totpCode.trim()) && { opacity: 0.6 }]}
                >
                  {isChallenging ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle-outline" size={20} color="#FFF" />
                      <Text style={styles.signInPrimaryBtnText}>Verify</Text>
                    </>
                  )}
                </Pressable>
                <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 }}>
                  <Pressable
                    onPress={() => { setUseBackupCode(!useBackupCode); setTotpCode(""); setError(null); }}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.tint }}>
                      {useBackupCode ? "Use authenticator app" : "Use backup code"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setTwoFactorPendingToken(null); setTotpCode(""); setError(null); }}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.tint }}>Back</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
            <>
            <View style={styles.inputGroup}>
              <View>
                <Text style={styles.signInFieldLabel}>Username</Text>
                <View style={styles.signInInputWrapper}>
                <Ionicons name="person-outline" size={18} color={Colors.light.textTertiary} style={styles.inputIcon} />
                <TextInput
                  style={styles.signInInput}
                  value={username}
                  onChangeText={(t) => { setUsername(t); setError(null); }}
                  placeholder="Username"
                  placeholderTextColor={Colors.light.textTertiary}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoggingIn}
                  testID="login-username"
                />
                </View>
              </View>
              {isSharedTestEmail(username) && (
                <Text
                  style={{ color: Colors.light.textSecondary, fontSize: 12, lineHeight: 18, paddingHorizontal: 4 }}
                  testID="shared-email-login-guidance"
                >
                  These test accounts share an email address. Sign in with the account’s unique username because email sign-in can’t distinguish them.
                </Text>
              )}

              <View>
                <Text style={styles.signInFieldLabel}>Password</Text>
                <View style={styles.signInInputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color={Colors.light.textTertiary} style={styles.inputIcon} />
                <TextInput
                  style={[styles.signInInput, { flex: 1 }]}
                  value={password}
                  onChangeText={(t) => { setPassword(t); setError(null); }}
                  placeholder="Password"
                  placeholderTextColor={Colors.light.textTertiary}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  editable={!isLoggingIn}
                  testID="login-password"
                />
                <Pressable
                  onPress={() => setShowPassword(!showPassword)}
                  style={styles.signInEyeBtn}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                  testID="login-toggle-password"
                >
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={19} color={Colors.light.tint} />
                </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.signInOptionsRow}>
              <Pressable
                onPress={() => setRememberMe(!rememberMe)}
                style={styles.signInRememberToggle}
                testID="remember-me-toggle"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: rememberMe }}
              >
                <View style={{
                  width: 20,
                  height: 20,
                  borderRadius: 5,
                  borderWidth: 1.5,
                  borderColor: rememberMe ? Colors.light.tint : Colors.light.border,
                  backgroundColor: rememberMe ? Colors.light.tint : Colors.light.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}>
                  {rememberMe && <Ionicons name="checkmark" size={13} color="#FFF" />}
                </View>
                <Text style={styles.signInRememberText}>Remember me</Text>
              </Pressable>
              <View style={styles.signInRecoveryLinks}>
                <Pressable onPress={openForgotUsername} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                  <Text style={styles.signInLink}>Forgot username?</Text>
                </Pressable>
                <Pressable onPress={openForgotPassword} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                  <Text style={styles.signInLink}>Forgot password?</Text>
                </Pressable>
              </View>
            </View>

            <Pressable
              onPress={handleLogin}
              disabled={isLoggingIn}
              style={({ pressed }) => [styles.signInPrimaryBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, isLoggingIn && { opacity: 0.6 }]}
              testID="login-submit"
            >
              {isLoggingIn ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="log-in-outline" size={20} color="#FFF" />
                    <Text style={styles.signInPrimaryBtnText}>Sign In</Text>
                </>
              )}
            </Pressable>

            {biometricAvailable && (
              <>
                <View style={styles.signInDividerRow}>
                  <View style={styles.signInDividerLine} />
                  <Text style={styles.signInDividerText}>or</Text>
                  <View style={styles.signInDividerLine} />
                </View>

                <Pressable
                  onPress={handleBiometricLogin}
                  disabled={isLoggingIn}
                  style={({ pressed }) => [styles.signInBiometricBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
                  testID="login-biometric"
                >
                  <Ionicons
                    name={biometricType === "Face ID" ? "scan" : "finger-print"}
                    size={24}
                    color={Colors.light.tint}
                  />
                  <Text style={styles.biometricBtnText}>Sign in with {biometricType}</Text>
                </Pressable>
              </>
            )}
            </>
            )}
          </View>

          <View style={styles.bottomSection}>
            <Pressable
              onPress={switchToSignUp}
              accessibilityRole="button"
              accessibilityLabel="Create account"
              style={({ pressed }) => [
                styles.createAccountButton,
                pressed && { opacity: 0.82, transform: [{ scale: 0.98 }] },
              ]}
              testID="switch-mode-btn"
            >
              <Text style={styles.createAccountButtonText}>Create account</Text>
            </Pressable>
            <View style={{ paddingHorizontal: 24, paddingTop: 12 }} testID="login-hipaa-notice">
              <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#64748B", textAlign: "center", lineHeight: 16 }}>
                By logging in, you acknowledge that this system contains Protected Health Information (PHI) subject to HIPAA regulations. Unauthorized access is prohibited and may result in civil and criminal penalties.
              </Text>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 16, marginBottom: 8 }}>
              <Pressable onPress={() => router.push("/privacy-policy")} style={({ pressed }) => [pressed && { opacity: 0.7 }]} testID="login-privacy-policy">
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.tint, textDecorationLine: "underline" }}>Privacy Policy</Text>
              </Pressable>
              <Pressable onPress={() => router.push("/terms-of-service")} style={({ pressed }) => [pressed && { opacity: 0.7 }]} testID="login-terms-of-service">
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: Colors.light.tint, textDecorationLine: "underline" }}>Terms of Service</Text>
              </Pressable>
            </View>
            <View style={styles.footer}>
              <Text style={styles.footerText}>Secure Access Only</Text>
              <Ionicons name="shield-checkmark" size={14} color={Colors.light.textTertiary} />
            </View>
            <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 6 }}>v{Constants.expoConfig?.version || "1.0.0"} (Build {Constants.expoConfig?.ios?.buildNumber || "1"})</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showForgotPassword} transparent animationType="fade" onRequestClose={() => setShowForgotPassword(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setShowForgotPassword(false)}>
          <Pressable style={{ backgroundColor: "#1E293B", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }} onPress={dismissKeyboardOnModalTap}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#FFF" }}>Forgot Password</Text>
              <Pressable onPress={() => setShowForgotPassword(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </Pressable>
            </View>
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: "#94A3B8", marginBottom: 20, lineHeight: 20 }}>
              Enter the email address associated with your account. We'll send you a link to reset your password.
            </Text>
            {forgotError && (
              <View style={{ backgroundColor: "rgba(239,68,68,0.15)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#FCA5A5", fontSize: 13, fontFamily: "Inter_500Medium" }}>{forgotError}</Text>
              </View>
            )}
            {forgotSuccess && (
              <View style={{ backgroundColor: "rgba(34,197,94,0.15)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#86EFAC", fontSize: 13, fontFamily: "Inter_500Medium" }}>{forgotSuccess}</Text>
              </View>
            )}
            {demoResetInfo && (
              <View style={{ backgroundColor: "rgba(245,158,11,0.15)", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#FCD34D", fontSize: 12, fontFamily: "Inter_500Medium" }}>{demoResetInfo}</Text>
              </View>
            )}
            {!forgotSuccess && (
              <>
                <View style={{ backgroundColor: "#0F172A", borderRadius: 12, borderWidth: 1, borderColor: "#334155", flexDirection: "row", alignItems: "center", paddingHorizontal: 14, marginBottom: 20 }}>
                  <Ionicons name="mail-outline" size={18} color="rgba(255,255,255,0.4)" />
                  <TextInput
                    style={{ flex: 1, color: "#FFF", fontSize: 15, fontFamily: "Inter_500Medium", paddingVertical: 14, paddingLeft: 10 }}
                    value={forgotEmail}
                    onChangeText={(t) => { setForgotEmail(t); setForgotError(null); }}
                    placeholder="Email address"
                    placeholderTextColor="rgba(255,255,255,0.3)"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!forgotLoading}
                  />
                </View>
                <Pressable
                  onPress={handleForgotPassword}
                  disabled={forgotLoading}
                  style={({ pressed }) => ({ backgroundColor: "#4A6CF7", borderRadius: 12, paddingVertical: 14, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.85 : forgotLoading ? 0.6 : 1 })}
                >
                  {forgotLoading ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Send Reset Link</Text>
                  )}
                </Pressable>
              </>
            )}
            {forgotSuccess && (
              <Pressable
                onPress={() => setShowForgotPassword(false)}
                style={({ pressed }) => ({ backgroundColor: "#334155", borderRadius: 12, paddingVertical: 14, alignItems: "center", opacity: pressed ? 0.85 : 1 })}
              >
                <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Back to Sign In</Text>
              </Pressable>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={showForgotUsername} transparent animationType="fade" onRequestClose={() => setShowForgotUsername(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setShowForgotUsername(false)}>
          <Pressable style={{ backgroundColor: "#1E293B", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }} onPress={dismissKeyboardOnModalTap}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#FFF" }}>Forgot Username</Text>
              <Pressable onPress={() => setShowForgotUsername(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </Pressable>
            </View>
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: "#94A3B8", marginBottom: 20, lineHeight: 20 }}>
              Enter the email address associated with your account. We'll email you a secure link — open it and enter your password to view your username.
            </Text>
            {forgotError && (
              <View style={{ backgroundColor: "rgba(239,68,68,0.15)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#FCA5A5", fontSize: 13, fontFamily: "Inter_500Medium" }}>{forgotError}</Text>
              </View>
            )}
            {forgotSuccess && (
              <View style={{ backgroundColor: "rgba(34,197,94,0.15)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#86EFAC", fontSize: 13, fontFamily: "Inter_500Medium" }}>{forgotSuccess}</Text>
              </View>
            )}
            {demoResetInfo && (
              <View style={{ backgroundColor: "rgba(245,158,11,0.15)", borderWidth: 1, borderColor: "rgba(245,158,11,0.3)", borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <Text style={{ color: "#FCD34D", fontSize: 12, fontFamily: "Inter_500Medium" }}>{demoResetInfo}</Text>
              </View>
            )}
            {!forgotSuccess && (
              <>
                <View style={{ backgroundColor: "#0F172A", borderRadius: 12, borderWidth: 1, borderColor: "#334155", flexDirection: "row", alignItems: "center", paddingHorizontal: 14, marginBottom: 20 }}>
                  <Ionicons name="mail-outline" size={18} color="rgba(255,255,255,0.4)" />
                  <TextInput
                    style={{ flex: 1, color: "#FFF", fontSize: 15, fontFamily: "Inter_500Medium", paddingVertical: 14, paddingLeft: 10 }}
                    value={forgotEmail}
                    onChangeText={(t) => { setForgotEmail(t); setForgotError(null); }}
                    placeholder="Email address"
                    placeholderTextColor="rgba(255,255,255,0.3)"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!forgotLoading}
                  />
                </View>
                <Pressable
                  onPress={handleForgotUsername}
                  disabled={forgotLoading}
                  style={({ pressed }) => ({ backgroundColor: "#4A6CF7", borderRadius: 12, paddingVertical: 14, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.85 : forgotLoading ? 0.6 : 1 })}
                >
                  {forgotLoading ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Send Link</Text>
                  )}
                </Pressable>
              </>
            )}
            {forgotSuccess && (
              <Pressable
                onPress={() => setShowForgotUsername(false)}
                style={({ pressed }) => ({ backgroundColor: "#334155", borderRadius: 12, paddingVertical: 14, alignItems: "center", opacity: pressed ? 0.85 : 1 })}
              >
                <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Back to Sign In</Text>
              </Pressable>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </DismissKeyboardView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.light.backgroundSolid,
  },
  flex: {
    flex: 1,
  },
  loginContent: {
    flexGrow: 1,
    width: "100%",
    alignSelf: "center",
    ...(Platform.OS === "web" ? { maxWidth: 480 as number } : {}),
  },
  signInBrandHeader: {
    paddingHorizontal: 24,
    paddingBottom: 23,
    backgroundColor: Colors.light.tintDark,
    borderBottomLeftRadius: 26,
    borderBottomRightRadius: 26,
    overflow: "hidden",
  },
  signInBrandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  signInBrandIcon: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: "#FFFFFF",
  },
  signInBrandCopy: {
    flex: 1,
    gap: 3,
  },
  signInBrandName: {
    fontSize: 25,
    lineHeight: 30,
    fontFamily: "Inter_700Bold",
    color: "#FFFFFF",
    letterSpacing: -0.5,
  },
  signInBrandTagline: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.76)",
    letterSpacing: 0.2,
  },
  signInBrandRule: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 18,
  },
  signInBrandRuleLine: {
    width: 22,
    height: 2,
    borderRadius: 1,
    backgroundColor: "#92C8F6",
  },
  signInBrandCaption: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.78)",
  },
  signInCard: {
    marginHorizontal: 18,
    marginTop: -12,
    padding: 22,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 20,
    backgroundColor: Colors.light.surface,
    shadowColor: "#173D68",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 18,
    elevation: 5,
  },
  signInCardHeading: {
    gap: 4,
    marginBottom: 2,
  },
  signInHeading: {
    fontSize: 24,
    lineHeight: 30,
    fontFamily: "Inter_700Bold",
    color: Colors.light.text,
    letterSpacing: -0.4,
  },
  signInSubheading: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: "Inter_400Regular",
    color: Colors.light.textSecondary,
  },
  signInFieldLabel: {
    marginBottom: 7,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.text,
  },
  signInInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 50,
    backgroundColor: Colors.light.surface,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 11,
    paddingHorizontal: 13,
  },
  signInInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: Colors.light.text,
  },
  signInEyeBtn: {
    minWidth: 38,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  signInOptionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 2,
  },
  signInRememberToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingVertical: 4,
  },
  signInRememberText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textSecondary,
  },
  signInRecoveryLinks: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 11,
  },
  signInLink: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  signInErrorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: Colors.light.errorSurface,
    borderWidth: 1,
    borderColor: Colors.light.errorLight,
    borderRadius: 11,
    padding: 12,
  },
  signInErrorText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: "Inter_500Medium",
    color: Colors.light.errorText,
  },
  signInPrimaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 50,
    backgroundColor: Colors.light.tint,
    paddingVertical: 14,
    borderRadius: 11,
    marginTop: 1,
  },
  signInPrimaryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#FFFFFF",
  },
  signInDividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  signInDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: Colors.light.border,
  },
  signInDividerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
  signInBiometricBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    minHeight: 50,
    backgroundColor: Colors.light.infoSurface,
    borderWidth: 1,
    borderColor: Colors.light.infoLight,
    paddingVertical: 13,
    borderRadius: 11,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    ...(Platform.OS === "web" ? { maxWidth: 480, alignSelf: "center" as const, width: "100%" as any } : {}),
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
    ...(Platform.OS === "web" ? { maxWidth: 480, alignSelf: "center" as const, width: "100%" as any } : {}),
  },
  credentialsScrollContent: {
    paddingHorizontal: 20,
  },
  credentialsBackBtn: {
    marginTop: -4,
    marginBottom: 2,
  },
  credentialsBrandHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 16,
    paddingHorizontal: 2,
  },
  credentialsBrandIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: "#FFFFFF",
  },
  credentialsBrandCopy: {
    gap: 2,
  },
  credentialsBrandName: {
    fontSize: 21,
    lineHeight: 25,
    fontFamily: "Inter_700Bold",
    color: "#10213D",
    letterSpacing: -0.3,
  },
  credentialsBrandTagline: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    color: "#6C829C",
    letterSpacing: 1.7,
  },
  credentialsCard: {
    padding: 20,
    borderWidth: 1,
    borderColor: "#E3EBF5",
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    shadowColor: "#173D68",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.09,
    shadowRadius: 18,
    elevation: 4,
  },
  credentialsProgress: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  credentialsProgressBars: {
    flex: 1,
    flexDirection: "row",
    gap: 4,
  },
  credentialsProgressBar: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#E8EEF5",
  },
  credentialsProgressBarActive: {
    backgroundColor: "#1466B4",
  },
  credentialsProgressLabel: {
    fontSize: 8,
    fontFamily: "Inter_600SemiBold",
    color: "#71839A",
    letterSpacing: 1,
  },
  credentialsHeading: {
    fontSize: 24,
    lineHeight: 29,
    fontFamily: "Inter_700Bold",
    color: "#0B1433",
    letterSpacing: -0.45,
  },
  credentialsSubheading: {
    marginTop: 3,
    marginBottom: 18,
    fontSize: 13,
    lineHeight: 19,
    fontFamily: "Inter_400Regular",
    color: "#5B6F8A",
  },
  credentialsFormSection: {
    gap: 14,
  },
  credentialsErrorBanner: {
    padding: 10,
    borderRadius: 10,
  },
  credentialsFieldGroup: {
    gap: 5,
  },
  credentialsFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#10213D",
  },
  credentialsFieldHint: {
    fontSize: 10,
    lineHeight: 14,
    fontFamily: "Inter_400Regular",
    color: "#788BA2",
  },
  credentialsInputWrapper: {
    minHeight: 45,
    backgroundColor: "#F7FAFD",
    borderColor: "#CFE0F2",
    borderRadius: 9,
    paddingHorizontal: 11,
  },
  credentialsInput: {
    paddingVertical: 11,
    fontSize: 14,
    color: "#10213D",
  },
  credentialsEyeBtn: {
    minWidth: 38,
    minHeight: 38,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 2,
    padding: 0,
  },
  credentialsSharedEmail: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: "#D4E7FA",
    borderRadius: 9,
    backgroundColor: "#EAF4FE",
  },
  credentialsSharedEmailText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: "Inter_400Regular",
    color: "#385D84",
  },
  credentialsPwRequirements: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
    paddingHorizontal: 1,
  },
  credentialsPwReqRow: {
    width: "48%",
    gap: 5,
  },
  credentialsPwReqText: {
    fontSize: 10,
    color: "#71839A",
  },
  credentialsContinueButton: {
    minHeight: 48,
    paddingVertical: 12,
    marginTop: 1,
    borderRadius: 9,
  },
  credentialsSignIn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    marginTop: 15,
    paddingTop: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E3EBF5",
  },
  credentialsSignInText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#71839A",
  },
  credentialsSignInLink: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: "#1768B7",
  },
  welcomeActionFooter: {
    paddingHorizontal: 28,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
    backgroundColor: "#0F172A",
  },
  welcomeActionButton: {
    backgroundColor: Colors.light.tint,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  welcomeActionText: {
    ...Typography.bodySemibold,
    color: "#fff",
    fontSize: 16,
  },
  backBtn: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  logoSection: {
    alignItems: "center",
    marginTop: 20,
    marginBottom: 32,
  },
  logoContainer: {
    marginBottom: 16,
  },
  logoGradient: {
    width: 72,
    height: 72,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  appName: {
    fontSize: 26,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    letterSpacing: -0.5,
  },
  appTagline: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.4)",
    marginTop: 6,
    textAlign: "center",
  },
  formSection: {
    gap: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.dark.text,
    paddingVertical: 8,
  },
  primaryBtn: {
    alignItems: "center",
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    borderRadius: 16,
  },
  primaryBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.dark.text,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(239,68,68,0.15)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.3)",
    borderRadius: 14,
    padding: 14,
  },
  errorText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: Colors.light.error,
    flex: 1,
  },
  inputGroup: {
    gap: 12,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 16,
    paddingHorizontal: 16,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 16,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#FFF",
  },
  eyeBtn: {
    padding: 4,
    marginLeft: 8,
  },
  loginBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    borderRadius: 16,
    marginTop: 4,
  },
  loginBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  createAccountButton: {
    width: "100%",
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: Colors.light.tint,
    borderRadius: 12,
    paddingVertical: 14,
    backgroundColor: Colors.light.surface,
  },
  createAccountButtonText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  dividerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.3)",
  },
  biometricBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "rgba(37,99,235,0.12)",
    borderWidth: 1,
    borderColor: "rgba(37,99,235,0.25)",
    paddingVertical: 16,
    borderRadius: 16,
  },
  biometricBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  bottomSection: {
    gap: 12,
    marginHorizontal: 18,
    marginTop: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 18,
    backgroundColor: Colors.light.surface,
    shadowColor: "#173D68",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  switchText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.45)",
  },
  switchLink: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: Colors.light.tint,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  footerText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: Colors.light.textTertiary,
  },
  pwRequirements: {
    gap: 6,
    paddingHorizontal: 4,
  },
  pwReqRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pwReqText: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.35)",
  },
  pwReqMet: {
    color: "#22C55E",
  },
  optInCard: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    gap: 16,
  },
  optInIconRow: {
    marginBottom: 4,
  },
  optInIcon: {
    width: 64,
    height: 64,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
  },
  optInTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    textAlign: "center",
  },
  optInDesc: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.55)",
    textAlign: "center",
    lineHeight: 20,
  },
  optInBtns: {
    gap: 12,
    width: "100%",
    marginTop: 4,
  },
  optInYes: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: Colors.light.tint,
    paddingVertical: 16,
    borderRadius: 16,
  },
  optInYesText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  optInNo: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    paddingVertical: 16,
    borderRadius: 16,
  },
  optInNoText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "rgba(255,255,255,0.6)",
  },
  helperText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.35)",
    textAlign: "center",
  },
  verifyInfo: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
  },
  verifyInfoText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.55)",
  },
  demoCodeBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(245,158,11,0.15)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.3)",
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  demoCodeLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#F59E0B",
  },
  demoCodeValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    letterSpacing: 4,
  },
  codeInputRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginVertical: 8,
  },
  codeBox: {
    width: 46,
    height: 54,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.12)",
    textAlign: "center",
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  codeBoxFilled: {
    borderColor: Colors.light.tint,
    backgroundColor: "rgba(37,99,235,0.12)",
  },
  resendBtn: {
    alignItems: "center",
    paddingVertical: 12,
  },
  resendText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: Colors.light.tint,
  },
  stepIndicator: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 32,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  stepDotActive: {
    backgroundColor: Colors.light.tint,
    width: 24,
  },
  optionCard: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 20,
    padding: 24,
    gap: 8,
  },
  optionCardSelected: {
    borderColor: Colors.light.tint,
  },
  optionCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  optionCardIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  optionCheckBadge: {
    position: "absolute" as const,
    right: 0,
    top: 0,
  },
  optionCardTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
  },
  optionCardDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.5)",
    lineHeight: 18,
  },
  hipaaCard: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 20,
    padding: 20,
    maxHeight: 280,
  },
  hipaaScroll: {
    flexGrow: 0,
  },
  hipaaTitle: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#FFF",
    marginBottom: 8,
    marginTop: 12,
  },
  hipaaBody: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "rgba(255,255,255,0.55)",
    lineHeight: 18,
    marginBottom: 6,
  },
  hipaaCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 4,
  },
  hipaaCheckbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  hipaaCheckboxChecked: {
    backgroundColor: Colors.light.tint,
    borderColor: Colors.light.tint,
  },
  hipaaCheckLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: "rgba(255,255,255,0.6)",
    flex: 1,
  },
});
