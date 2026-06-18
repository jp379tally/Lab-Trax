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
  Keyboard,
  TouchableWithoutFeedback,
  Modal,
  Alert,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import Constants from "expo-constants";
import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, getApiUrl } from "@/lib/query-client";
import { generateId, GroupJoinRequest } from "@/lib/data";
import Colors from "@/constants/colors";
import { Typography, Spacing } from "@/constants/tokens";

type SignUpStep = "welcome" | "credentials" | "user_type" | "lab_name" | "lab_info" | "license" | "practice_info" | "email_verify" | "updates_opt_in" | "phone_entry" | "phone_verify" | "phone_contact_name" | "role_select" | "join_group" | "hipaa_disclaimer" | "complete";

function validatePassword(pw: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (pw.length < 8) errors.push("At least 8 characters");
  if (!/[A-Z]/.test(pw)) errors.push("One uppercase letter");
  if (!/[a-z]/.test(pw)) errors.push("One lowercase letter");
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) errors.push("One special character");
  return { valid: errors.length === 0, errors };
}

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login, completeTwoFactor, loginWithBiometric, register, registeredUsers } = useAuth();
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

  const [signUpStep, setSignUpStep] = useState<SignUpStep>("credentials");
  const [signUpUsername, setSignUpUsername] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [signUpConfirmPassword, setSignUpConfirmPassword] = useState("");
  const [signUpEmail, setSignUpEmail] = useState("");
  const [signUpPhone, setSignUpPhone] = useState("");
  const [wantsUpdates, setWantsUpdates] = useState(false);
  const [showSignUpPassword, setShowSignUpPassword] = useState(false);
  const [signUpError, setSignUpError] = useState<string | null>(null);
  const [signUpLoading, setSignUpLoading] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);

  const [phoneCode, setPhoneCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSending, setCodeSending] = useState(false);
  const [codeResendTimer, setCodeResendTimer] = useState(0);
  const [demoPhoneCode, setDemoPhoneCode] = useState<string | null>(null);
  const [demoEmailCode, setDemoEmailCode] = useState<string | null>(null);

  const [userType, setUserType] = useState<"provider" | "lab" | null>(null);
  const [licenseNumber, setLicenseNumber] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [doctorName, setDoctorName] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [zipCode, setZipCode] = useState("");
  const [fetchingLocation, setFetchingLocation] = useState(false);
  const [practicePhone, setPracticePhone] = useState("");
  const [phoneContactName, setPhoneContactName] = useState("");
  const [selectedRole, setSelectedRole] = useState<"user" | "admin" | null>(null);
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
  const [matchingLabGroup, setMatchingLabGroup] = useState<{ organizationId: string; practiceName: string; username: string; practiceAddress?: string } | null>(null);
  const [labJoinRequestSent, setLabJoinRequestSent] = useState(false);
  const [checkingLabName, setCheckingLabName] = useState(false);
  const [browseExistingLabs, setBrowseExistingLabs] = useState(false);
  const [allLabGroups, setAllLabGroups] = useState<{ organizationId: string; practiceName: string; username: string; practiceAddress?: string; memberCount?: number }[]>([]);
  const [labSearchFilter, setLabSearchFilter] = useState("");
  // Claim-existing-practice flow: a provider supplies the lab they belong to
  // and the account number their lab gave them. We submit this to the server
  // as `claimProvider` on /auth/register, which files a join request against
  // the existing practice org instead of creating a new one.
  const [claimMode, setClaimMode] = useState(false);
  const [claimLab, setClaimLab] = useState<{ id: string; displayName: string } | null>(null);
  const [claimLabSearch, setClaimLabSearch] = useState("");
  const [claimLabResults, setClaimLabResults] = useState<Array<{ id: string; displayName: string; city?: string | null; state?: string | null }>>([]);
  const [claimLabLoading, setClaimLabLoading] = useState(false);
  const [claimAccountNumber, setClaimAccountNumber] = useState("");

  const codeInputRefs = useRef<(TextInput | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkBiometricAvailability();
    AsyncStorage.getItem("@labtrax_remember_me").then((val) => {
      if (val !== null) setRememberMe(val === "true");
    }).catch(() => {});
  }, []);

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

  function switchToSignUp() {
    setMode("signup");
    setSignUpStep("welcome");
    setSignUpUsername("");
    setSignUpPassword("");
    setSignUpConfirmPassword("");
    setSignUpEmail("");
    setSignUpPhone("");
    setWantsUpdates(false);
    setSignUpError(null);
    setPasswordTouched(false);
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
    setSelectedRole(null);
    setHipaaAccepted(false);
    setAccountNumber("");
    setJoinGroupAdminUsername("");
    setJoinGroupSent(false);
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
    setError(null);
    setIsLoggingIn(true);
    const result = await login(username.trim(), password.trim(), rememberMe);
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
      setForgotSuccess(data.message || "If an account with that email exists, your username has been sent.");
      if (data.demoUsername) {
        setDemoResetInfo(`Your username is: ${data.demoUsername}`);
      }
    } catch (e: any) {
      setForgotError(e?.message || "Failed to process request. Please try again.");
    } finally {
      setForgotLoading(false);
    }
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

    const emailMatch = registeredUsers.find(u => u.email && u.email.toLowerCase() === signUpEmail.trim().toLowerCase());
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
    } else {
      setSignUpStep("role_select");
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
    setSignUpLoading(true);
    try {
      let acctNum: string;
      if (userType === "provider") {
        const yy = new Date().getFullYear() % 100;
        let count = 1;
        try {
          const raw = await AsyncStorage.getItem("@drivesync_provider_counter");
          if (raw) {
            const counter = JSON.parse(raw);
            if (counter.year === yy) {
              count = (counter.count || 0) + 1;
            }
          }
        } catch {}
        acctNum = `${yy}-${count}`;
        await AsyncStorage.setItem("@drivesync_provider_counter", JSON.stringify({ year: yy, count }));
      } else {
        acctNum = "DS-" + Date.now().toString().slice(-6);
      }

      const isLab = (userType || "provider") === "lab";
      const resolvedAddress = isLab
        ? [labStreet.trim(), labCity.trim(), labState.trim(), labZip.trim()].filter(Boolean).join(", ")
        : [streetAddress.trim(), city.trim(), zipCode.trim()].filter(Boolean).join(", ");
      const resolvedPhone = isLab ? labPhone.trim() : practicePhone.trim();
      const resolvedEmail = isLab ? (labEmail.trim() || signUpEmail.trim()) : signUpEmail.trim();

      // When the provider is claiming an existing practice their lab already
      // created, we send claim info instead of asking the server to create a
      // new organization. The server files a join request against the
      // existing provider org.
      const isClaim = !isLab && claimMode && !!claimLab && !!claimAccountNumber.trim();

      const result = await register({
        username: signUpUsername.trim(),
        password: signUpPassword,
        email: resolvedEmail,
        phone: wantsUpdates ? signUpPhone.trim() : undefined,
        wantsUpdates,
        userType: userType || "provider",
        licenseNumber: licenseNumber.trim(),
        practiceName: isLab ? labName.trim() : practiceName.trim(),
        doctorName: doctorName.trim(),
        practiceAddress: resolvedAddress,
        practicePhone: resolvedPhone,
        phoneContactName: wantsUpdates ? phoneContactName.trim() : undefined,
        role: selectedRole || "user",
        accountNumber: acctNum,
        createOrganization: !isClaim,
        claimProvider: isClaim
          ? {
              labId: claimLab!.id,
              accountNumber: claimAccountNumber.trim(),
            }
          : undefined,
      });
      if (!result.success) {
        setSignUpError(result.error || "Registration failed.");
      } else {
        // After successful registration the user has a valid session.
        // Flush any join requests that were queued during the join_group step.
        try {
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
                        requestedRole: selectedRole || "user",
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
      }
    } catch {
      setSignUpError("Registration failed. Please try again.");
    }
    setSignUpLoading(false);
  }

  const pwValidation = validatePassword(signUpPassword);

  if (mode === "signup") {
    return (
      <View style={styles.container}>
        <LinearGradient
          colors={["#0F172A", "#1E293B", "#0F172A"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.flex}
        >
          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              {
                paddingTop: Platform.OS === "web" ? 67 + 30 : insets.top + 30,
                paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
            onScrollBeginDrag={Keyboard.dismiss}
          >
            <Pressable
              onPress={() => {
                setSignUpError(null);
                if (signUpStep === "welcome") {
                  switchToSignIn();
                } else if (signUpStep === "credentials") {
                  switchToSignIn();
                } else if (signUpStep === "user_type") {
                  setSignUpStep("credentials");
                } else if (signUpStep === "license") {
                  setSignUpStep("user_type");
                } else if (signUpStep === "practice_info") {
                  setSignUpStep("license");
                } else if (signUpStep === "lab_name") {
                  setMatchingLabGroup(null);
                  setLabJoinRequestSent(false);
                  setSignUpStep("user_type");
                } else if (signUpStep === "lab_info") {
                  setSignUpStep("lab_name");
                } else if (signUpStep === "email_verify") {
                  setSignUpStep(userType === "lab" ? "lab_info" : "practice_info");
                } else if (signUpStep === "updates_opt_in") {
                  setSignUpStep("email_verify");
                } else if (signUpStep === "phone_entry") {
                  setSignUpStep("updates_opt_in");
                } else if (signUpStep === "phone_verify") {
                  setSignUpStep("phone_entry");
                } else if (signUpStep === "phone_contact_name") {
                  setSignUpStep("phone_verify");
                } else if (signUpStep === "role_select") {
                  if (wantsUpdates) {
                    setSignUpStep("phone_contact_name");
                  } else {
                    setSignUpStep("updates_opt_in");
                  }
                } else if (signUpStep === "hipaa_disclaimer") {
                  setSignUpStep("join_group");
                } else if (signUpStep === "join_group") {
                  setSignUpStep("role_select");
                }
              }}
              style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.6 }]}
              testID="signup-back-btn"
            >
              <Ionicons name="arrow-back" size={22} color="rgba(255,255,255,0.7)" />
            </Pressable>

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
                {signUpStep === "credentials" && "Enter your details to get started"}
                {signUpStep === "user_type" && "What type of account?"}
                {signUpStep === "lab_name" && "Enter your lab name"}
                {signUpStep === "lab_info" && "Enter your lab details"}
                {signUpStep === "license" && (userType === "lab" ? "Enter your lab license number" : "Enter your dental license number")}
                {signUpStep === "practice_info" && "Tell us about your practice"}
                {signUpStep === "updates_opt_in" && "Stay connected with your lab"}
                {signUpStep === "phone_entry" && "Enter your phone number"}
                {signUpStep === "phone_verify" && "Verify your phone number"}
                {signUpStep === "phone_contact_name" && "Who will receive text updates?"}
                {signUpStep === "email_verify" && "Verify your email address"}
                {signUpStep === "role_select" && "Select your role"}
                {signUpStep === "join_group" && (userType === "lab" ? "Connect with a Provider" : "Connect with the Lab")}
                {signUpStep === "hipaa_disclaimer" && "Review & Accept Terms"}
              </Text>
            </View>

            {signUpStep === "welcome" && renderWelcome()}
            {signUpStep === "credentials" && renderCredentialsStep()}
            {signUpStep === "user_type" && renderUserType()}
            {signUpStep === "lab_name" && renderLabName()}
            {signUpStep === "lab_info" && renderLabInfo()}
            {signUpStep === "license" && renderLicense()}
            {signUpStep === "practice_info" && renderPracticeInfo()}
            {signUpStep === "email_verify" && renderEmailVerify()}
            {signUpStep === "updates_opt_in" && renderUpdatesOptIn()}
            {signUpStep === "phone_entry" && renderPhoneEntry()}
            {signUpStep === "phone_verify" && renderPhoneVerify()}
            {signUpStep === "phone_contact_name" && renderPhoneContactName()}
            {signUpStep === "role_select" && renderRoleSelect()}
            {signUpStep === "join_group" && renderJoinGroup()}
            {signUpStep === "hipaa_disclaimer" && renderHipaaDisclaimer()}

            {signUpStep === "credentials" && (
              <View style={styles.bottomSection}>
                <View style={styles.switchRow}>
                  <Text style={styles.switchText}>Already have an account?</Text>
                  <Pressable onPress={switchToSignIn} style={({ pressed }) => [pressed && { opacity: 0.7 }]} testID="switch-to-signin">
                    <Text style={styles.switchLink}>Sign In</Text>
                  </Pressable>
                </View>
              </View>
            )}

            <View style={styles.stepIndicator}>
              {(() => {
                const labSteps: SignUpStep[] = ["credentials", "user_type", "lab_name", "lab_info", "email_verify", "updates_opt_in", "role_select", "join_group", "hipaa_disclaimer"];
                const providerSteps: SignUpStep[] = wantsUpdates
                  ? ["credentials", "user_type", "license", "practice_info", "email_verify", "updates_opt_in", "phone_entry", "phone_verify", "phone_contact_name", "join_group", "hipaa_disclaimer"]
                  : ["credentials", "user_type", "license", "practice_info", "email_verify", "updates_opt_in", "join_group", "hipaa_disclaimer"];
                const allSteps = userType === "lab" ? labSteps : providerSteps;
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
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
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
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("license");
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
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("lab_name");
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
        setMatchingLabGroup({ organizationId: match.organizationId, practiceName: match.practiceName, username: match.username, practiceAddress: match.practiceAddress });
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

  async function handleJoinExistingLab() {
    if (!matchingLabGroup) return;
    try {
      const regResult = await register({
        username: signUpUsername.trim(),
        password: signUpPassword,
        email: signUpEmail.trim(),
        phone: wantsUpdates ? signUpPhone.trim() : undefined,
        wantsUpdates,
        userType: userType || "lab",
        role: selectedRole || "user",
        licenseNumber: licenseNumber.trim(),
        practiceName: matchingLabGroup.practiceName,
        joinOrganizationId: matchingLabGroup.organizationId,
      });
      if (!regResult.success) {
        setSignUpError(regResult.error || "Could not send request. Please try again.");
        return;
      }
      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLabJoinRequestSent(true);
    } catch {
      setSignUpError("Could not send request. Please try again.");
    }
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

            <ScrollView style={{ maxHeight: 240 }} showsVerticalScrollIndicator={false}>
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
                      </View>
                      <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.3)" />
                    </Pressable>
                  ))
              )}
            </ScrollView>

            <Pressable
              onPress={() => { setBrowseExistingLabs(false); setSignUpError(null); }}
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
                setMatchingLabGroup(null);
                setSignUpError(null);
                if (browseExistingLabs) {
                  setBrowseExistingLabs(false);
                }
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
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Request Sent</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 18 }}>
              Your request to join {matchingLabGroup?.practiceName} has been sent to the lab admin. You'll be notified when they respond.
            </Text>
            <Pressable
              onPress={() => {
                setSignUpStep("hipaa_disclaimer");
              }}
              style={({ pressed }) => [
                styles.loginBtn,
                { marginTop: 8 },
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
              ]}
            >
              <Text style={styles.loginBtnText}>Continue</Text>
              <Ionicons name="arrow-forward" size={20} color="#FFF" />
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
            setSignUpStep("practice_info");
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
          setSignUpError("Location not supported on this browser. Please type your address.");
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
          setSignUpError("Could not determine address. Please type it manually.");
        }
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== "granted") {
          setSignUpError("Location permission denied. Please type your address manually.");
          return;
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
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
            setSignUpError("Could not determine address. Please type it manually.");
          }
        } else {
          setSignUpError("Could not determine address. Please type it manually.");
        }
      }
    } catch (e: any) {
      setSignUpError("Location unavailable. Please type your address manually.");
    } finally {
      setFetchingLocation(false);
    }
  }

  async function searchClaimLabs(query: string) {
    setClaimLabSearch(query);
    setClaimLab(null);
    if (query.trim().length < 2) {
      setClaimLabResults([]);
      return;
    }
    setClaimLabLoading(true);
    try {
      const res = await apiRequest(
        "GET",
        `/api/labs/lookup?q=${encodeURIComponent(query.trim())}`
      );
      const data = await res.json();
      setClaimLabResults(Array.isArray(data?.labs) ? data.labs : []);
    } catch {
      setClaimLabResults([]);
    } finally {
      setClaimLabLoading(false);
    }
  }

  function renderClaimPracticeForm() {
    return (
      <View style={styles.inputGroup}>
        <View style={styles.inputWrapper}>
          <Ionicons
            name="search"
            size={18}
            color="rgba(255,255,255,0.4)"
            style={styles.inputIcon}
          />
          <TextInput
            style={styles.input}
            value={claimLab ? claimLab.displayName : claimLabSearch}
            onChangeText={(t) => {
              if (claimLab) setClaimLab(null);
              searchClaimLabs(t);
              setSignUpError(null);
            }}
            placeholder="Find your lab by name"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="words"
            testID="claim-lab-search"
          />
          {claimLabLoading && (
            <ActivityIndicator size={16} color="rgba(255,255,255,0.6)" />
          )}
        </View>

        {!claimLab && claimLabResults.length > 0 && (
          <View style={{ gap: 6 }}>
            {claimLabResults.map((lab) => (
              <Pressable
                key={lab.id}
                onPress={() => {
                  setClaimLab({ id: lab.id, displayName: lab.displayName });
                  setClaimLabResults([]);
                  setClaimLabSearch(lab.displayName);
                }}
                style={({ pressed }) => [
                  {
                    paddingVertical: 10,
                    paddingHorizontal: 12,
                    borderRadius: 8,
                    backgroundColor: pressed
                      ? "rgba(255,255,255,0.12)"
                      : "rgba(255,255,255,0.06)",
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.1)",
                  },
                ]}
                testID={`claim-lab-result-${lab.id}`}
              >
                <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "600" }}>
                  {lab.displayName}
                </Text>
                {(lab.city || lab.state) && (
                  <Text
                    style={{
                      color: "rgba(255,255,255,0.5)",
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  >
                    {[lab.city, lab.state].filter(Boolean).join(", ")}
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.inputWrapper}>
          <Ionicons
            name="key-outline"
            size={18}
            color="rgba(255,255,255,0.4)"
            style={styles.inputIcon}
          />
          <TextInput
            style={styles.input}
            value={claimAccountNumber}
            onChangeText={(t) => {
              setClaimAccountNumber(t);
              setSignUpError(null);
            }}
            placeholder="Account number from your lab"
            placeholderTextColor="rgba(255,255,255,0.3)"
            autoCapitalize="characters"
            autoCorrect={false}
            testID="claim-account-number"
          />
        </View>

        <Text
          style={{
            color: "rgba(255,255,255,0.5)",
            fontSize: 12,
            lineHeight: 18,
          }}
        >
          Ask your lab for your practice's account number. Once they approve
          your request, you'll see your existing cases automatically.
        </Text>
      </View>
    );
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

        <Pressable
          onPress={() => {
            setClaimMode((v) => !v);
            setSignUpError(null);
          }}
          style={({ pressed }) => [
            {
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 8,
              backgroundColor: claimMode
                ? "rgba(74,144,217,0.18)"
                : "rgba(255,255,255,0.06)",
              borderWidth: 1,
              borderColor: claimMode
                ? "rgba(74,144,217,0.5)"
                : "rgba(255,255,255,0.12)",
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              opacity: pressed ? 0.85 : 1,
            },
          ]}
          testID="claim-mode-toggle"
        >
          <Ionicons
            name={claimMode ? "checkbox" : "square-outline"}
            size={20}
            color={claimMode ? "#4A90D9" : "rgba(255,255,255,0.6)"}
          />
          <Text
            style={{
              color: "#FFF",
              fontSize: 13,
              flex: 1,
            }}
          >
            My lab already created my practice — I have an account number
          </Text>
        </Pressable>

        {claimMode ? (
          renderClaimPracticeForm()
        ) : (
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
        )}

        <Pressable
          onPress={() => {
            if (claimMode) {
              if (!claimLab) {
                setSignUpError("Please pick your lab from the search results.");
                return;
              }
              if (!claimAccountNumber.trim()) {
                setSignUpError("Please enter the account number your lab gave you.");
                return;
              }
              setSignUpError(null);
              sendEmailCode();
              return;
            }
            if (!practiceName.trim() || !doctorName.trim() || !streetAddress.trim() || !city.trim() || !zipCode.trim() || !practicePhone.trim()) {
              setSignUpError("All fields are required.");
              return;
            }
            const enteredPhone = practicePhone.trim().replace(/\D/g, "");
            const enteredAddress = [streetAddress.trim(), city.trim(), zipCode.trim()].filter(Boolean).join(", ").toLowerCase();

            const phoneMatch = registeredUsers.find(u => u.practicePhone && u.practicePhone.replace(/\D/g, "") === enteredPhone && enteredPhone.length >= 7);
            if (phoneMatch) {
              setSignUpError("This phone number is already associated with another account. Please enter a different phone number.");
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
          disabled={codeSending}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, codeSending && { opacity: 0.6 }]}
          testID="practice-info-next-btn"
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
            setSignUpStep("role_select");
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

  function renderRoleSelect() {
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
            setSelectedRole("user");
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("join_group");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            selectedRole === "user" && styles.optionCardSelected,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="role-user"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#10B981", "#059669"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="person" size={28} color="#FFF" />
            </LinearGradient>
            {selectedRole === "user" && (
              <View style={styles.optionCheckBadge}>
                <Ionicons name="checkmark-circle" size={24} color={Colors.light.tint} />
              </View>
            )}
          </View>
          <Text style={styles.optionCardTitle}>User</Text>
          <Text style={styles.optionCardDesc}>Standard user with access to case management</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            setSelectedRole("admin");
            if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setSignUpStep("join_group");
          }}
          style={({ pressed }) => [
            styles.optionCard,
            selectedRole === "admin" && styles.optionCardSelected,
            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
          ]}
          testID="role-admin"
        >
          <View style={styles.optionCardHeader}>
            <LinearGradient
              colors={["#F59E0B", "#D97706"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.optionCardIcon}
            >
              <Ionicons name="shield" size={28} color="#FFF" />
            </LinearGradient>
            {selectedRole === "admin" && (
              <View style={styles.optionCheckBadge}>
                <Ionicons name="checkmark-circle" size={24} color={Colors.light.tint} />
              </View>
            )}
          </View>
          <Text style={styles.optionCardTitle}>Administrator</Text>
          <Text style={styles.optionCardDesc}>Full access including pricing and management</Text>
        </Pressable>
      </View>
    );
  }

  function renderJoinGroup() {
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
                <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled">
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

  function renderHipaaDisclaimer() {
    return (
      <View style={styles.formSection}>
        {signUpError && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
            <Text style={styles.errorText}>{signUpError}</Text>
          </View>
        )}

        <View style={styles.hipaaCard}>
          <ScrollView style={styles.hipaaScroll} nestedScrollEnabled>
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

        <Pressable
          onPress={() => setSignUpStep("credentials")}
          style={({ pressed }) => [{
            backgroundColor: Colors.light.tint,
            borderRadius: 12,
            paddingVertical: 14,
            alignItems: "center",
            opacity: pressed ? 0.85 : 1,
          }]}
          testID="welcome-get-started-btn"
        >
          <Text style={{ ...Typography.bodySemibold, color: "#fff", fontSize: 16 }}>
            Get Started →
          </Text>
        </Pressable>
      </View>
    );
  }

  function renderCredentialsStep() {
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
            <Ionicons name="person-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={signUpUsername}
              onChangeText={(t) => { setSignUpUsername(t); setSignUpError(null); }}
              placeholder="Username (3–12 letters, numbers, _)"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={12}
              editable={!signUpLoading}
              testID="signup-username"
            />
          </View>

          <View style={styles.inputWrapper}>
            <Ionicons name="mail-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={signUpEmail}
              onChangeText={(t) => { setSignUpEmail(t); setSignUpError(null); }}
              placeholder="Email Address"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="oneTimeCode"
              autoComplete="off"
              editable={!signUpLoading}
              testID="signup-email"
            />
          </View>

          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={signUpPassword}
              onChangeText={(t) => { setSignUpPassword(t); setPasswordTouched(true); setSignUpError(null); }}
              placeholder="Password"
              placeholderTextColor="rgba(255,255,255,0.3)"
              secureTextEntry={!showSignUpPassword}
              autoCapitalize="none"
              textContentType="oneTimeCode"
              autoComplete="off"
              editable={!signUpLoading}
              testID="signup-password"
            />
            <Pressable onPress={() => setShowSignUpPassword(!showSignUpPassword)} style={styles.eyeBtn}>
              <Ionicons name={showSignUpPassword ? "eye-off-outline" : "eye-outline"} size={18} color="rgba(255,255,255,0.4)" />
            </Pressable>
          </View>

          {passwordTouched && (
            <View style={styles.pwRequirements}>
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
                    color={req.met ? "#22C55E" : "rgba(255,255,255,0.3)"}
                  />
                  <Text style={[styles.pwReqText, req.met && styles.pwReqMet]}>{req.label}</Text>
                </View>
              ))}
            </View>
          )}

          <View style={styles.inputWrapper}>
            <Ionicons name="lock-closed-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              value={signUpConfirmPassword}
              onChangeText={(t) => { setSignUpConfirmPassword(t); setSignUpError(null); }}
              placeholder="Confirm Password"
              placeholderTextColor="rgba(255,255,255,0.3)"
              secureTextEntry={!showSignUpPassword}
              autoCapitalize="none"
              textContentType="oneTimeCode"
              autoComplete="off"
              editable={!signUpLoading}
              testID="signup-confirm-password"
            />
          </View>
        </View>

        <Pressable
          onPress={handleCredentialsNext}
          disabled={signUpLoading}
          style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, signUpLoading && { opacity: 0.6 }]}
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
    <View style={styles.container}>
      <LinearGradient
        colors={["#0F172A", "#1E293B", "#0F172A"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: Platform.OS === "web" ? 67 + 40 : insets.top + 40,
              paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20,
            },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={Keyboard.dismiss}
        >
          <View style={styles.logoSection}>
            <View style={styles.logoContainer}>
              <Image
                source={require("@/assets/images/icon.png")}
                style={{ width: 80, height: 80, borderRadius: 20 }}
                resizeMode="contain"
              />
            </View>
            <Pressable onPress={() => {
              const next = diagTapCount + 1;
              setDiagTapCount(next);
              if (next >= 5) {
                const apiUrl = getApiUrl();
                const domain = process.env.EXPO_PUBLIC_DOMAIN || "(not set)";
                Alert.alert("Diagnostics", `API: ${apiUrl}\nDomain env: ${domain}\nPlatform: ${Platform.OS}\nBuild: 51`);
                setDiagTapCount(0);
              }
            }}>
              <Text style={styles.appName}>LabTrax</Text>
            </Pressable>
            <Text style={styles.appTagline}>Dental Laboratory Management</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8, backgroundColor: "rgba(16,185,129,0.12)", paddingHorizontal: 12, paddingVertical: 4, borderRadius: 20 }}>
              <Ionicons name="shield-checkmark" size={12} color="#10B981" />
              <Text style={{ fontSize: 11, fontFamily: "Inter_600SemiBold", color: "#10B981" }}>HIPAA Compliant</Text>
            </View>
          </View>

          <View style={styles.formSection}>
            {error && (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={16} color={Colors.light.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {twoFactorPendingToken ? (
              <View style={{ gap: 12 }}>
                <View style={{ alignItems: "center", marginBottom: 4 }}>
                  <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(59,130,246,0.15)", alignItems: "center", justifyContent: "center", marginBottom: 8 }}>
                    <Ionicons name="shield-checkmark" size={26} color="#60A5FA" />
                  </View>
                  <Text style={{ fontSize: 17, fontFamily: "Inter_600SemiBold", color: "#FFF", marginBottom: 4 }}>Two-Factor Verification</Text>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center" }}>
                    {useBackupCode
                      ? "Enter one of your saved backup codes."
                      : "Enter the 6-digit code from your authenticator app."}
                  </Text>
                </View>
                <View style={styles.inputWrapper}>
                  <Ionicons name="keypad-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, { letterSpacing: 4, textAlign: "center" }]}
                    value={totpCode}
                    onChangeText={(t) => {
                      setTotpCode(useBackupCode ? t.toUpperCase() : t.replace(/\D/g, "").slice(0, 6));
                      setError(null);
                    }}
                    placeholder={useBackupCode ? "BACKUP CODE" : "000000"}
                    placeholderTextColor="rgba(255,255,255,0.3)"
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
                    borderWidth: 2, borderColor: trustDevice ? "#60A5FA" : "rgba(255,255,255,0.3)",
                    backgroundColor: trustDevice ? "#60A5FA" : "transparent",
                    alignItems: "center", justifyContent: "center",
                  }}>
                    {trustDevice && <Ionicons name="checkmark" size={14} color="#FFF" />}
                  </View>
                  <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.8)" }}>
                    Trust this device for 30 days
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleTwoFactorChallenge}
                  disabled={isChallenging || !totpCode.trim()}
                  style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, (isChallenging || !totpCode.trim()) && { opacity: 0.6 }]}
                >
                  {isChallenging ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-circle-outline" size={20} color="#FFF" />
                      <Text style={styles.loginBtnText}>Verify</Text>
                    </>
                  )}
                </Pressable>
                <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4 }}>
                  <Pressable
                    onPress={() => { setUseBackupCode(!useBackupCode); setTotpCode(""); setError(null); }}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#60A5FA" }}>
                      {useBackupCode ? "Use authenticator app" : "Use backup code"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { setTwoFactorPendingToken(null); setTotpCode(""); setError(null); }}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#60A5FA" }}>Back</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
            <>
            <View style={styles.inputGroup}>
              <View style={styles.inputWrapper}>
                <Ionicons name="person-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
                <TextInput
                  style={styles.input}
                  value={username}
                  onChangeText={(t) => { setUsername(t); setError(null); }}
                  placeholder="Username"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isLoggingIn}
                  testID="login-username"
                />
              </View>

              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={18} color="rgba(255,255,255,0.4)" style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={password}
                  onChangeText={(t) => { setPassword(t); setError(null); }}
                  placeholder="Password"
                  placeholderTextColor="rgba(255,255,255,0.3)"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  editable={!isLoggingIn}
                  testID="login-password"
                />
                <Pressable onPress={() => setShowPassword(!showPassword)} style={styles.eyeBtn}>
                  <Ionicons name={showPassword ? "eye-off-outline" : "eye-outline"} size={18} color="rgba(255,255,255,0.4)" />
                </Pressable>
              </View>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 4, marginTop: 4, marginBottom: 12 }}>
              <Pressable onPress={openForgotPassword} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#60A5FA" }}>Forgot Password?</Text>
              </Pressable>
              <Pressable onPress={openForgotUsername} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "#60A5FA" }}>Forgot Username?</Text>
              </Pressable>
            </View>

            <Pressable
              onPress={() => setRememberMe(!rememberMe)}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, marginBottom: 16 }}
              testID="remember-me-toggle"
            >
              <View style={{
                width: 20,
                height: 20,
                borderRadius: 4,
                borderWidth: 1.5,
                borderColor: rememberMe ? "#60A5FA" : "rgba(255,255,255,0.3)",
                backgroundColor: rememberMe ? "#60A5FA" : "transparent",
                alignItems: "center",
                justifyContent: "center",
              }}>
                {rememberMe && <Ionicons name="checkmark" size={13} color="#FFF" />}
              </View>
              <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: "rgba(255,255,255,0.75)" }}>
                Remember Me
              </Text>
            </Pressable>

            <Pressable
              onPress={handleLogin}
              disabled={isLoggingIn}
              style={({ pressed }) => [styles.loginBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }, isLoggingIn && { opacity: 0.6 }]}
              testID="login-submit"
            >
              {isLoggingIn ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="log-in-outline" size={20} color="#FFF" />
                  <Text style={styles.loginBtnText}>Sign In</Text>
                </>
              )}
            </Pressable>

            {biometricAvailable && (
              <>
                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>

                <Pressable
                  onPress={handleBiometricLogin}
                  disabled={isLoggingIn}
                  style={({ pressed }) => [styles.biometricBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] }]}
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
            <View style={{ paddingHorizontal: 24, paddingTop: 12 }}>
              <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "#64748B", textAlign: "center", lineHeight: 16 }}>
                By logging in, you acknowledge that this system contains Protected Health Information (PHI) subject to HIPAA regulations. Unauthorized access is prohibited and may result in civil and criminal penalties.
              </Text>
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchText}>Don't have an account?</Text>
              <Pressable onPress={switchToSignUp} style={({ pressed }) => [pressed && { opacity: 0.7 }]} testID="switch-mode-btn">
                <Text style={styles.switchLink}>Sign Up</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", justifyContent: "center", gap: 16, marginBottom: 8 }}>
              <Pressable onPress={() => router.push("/privacy-policy")} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#60A5FA", textDecorationLine: "underline" }}>Privacy Policy</Text>
              </Pressable>
              <Pressable onPress={() => router.push("/terms-of-service")} style={({ pressed }) => [pressed && { opacity: 0.7 }]}>
                <Text style={{ fontSize: 12, fontFamily: "Inter_400Regular", color: "#60A5FA", textDecorationLine: "underline" }}>Terms of Service</Text>
              </Pressable>
            </View>
            <View style={styles.footer}>
              <Text style={styles.footerText}>Secure Access Only</Text>
              <Ionicons name="shield-checkmark" size={14} color="rgba(255,255,255,0.25)" />
            </View>
            <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.2)", marginTop: 6 }}>v{Constants.expoConfig?.version || "1.0.0"} (Build {Constants.expoConfig?.ios?.buildNumber || "1"})</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={showForgotPassword} transparent animationType="fade" onRequestClose={() => setShowForgotPassword(false)}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 }} onPress={() => setShowForgotPassword(false)}>
          <Pressable style={{ backgroundColor: "#1E293B", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }} onPress={() => {}}>
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
          <Pressable style={{ backgroundColor: "#1E293B", borderRadius: 20, padding: 24, width: "100%", maxWidth: 400 }} onPress={() => {}}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <Text style={{ fontSize: 20, fontFamily: "Inter_700Bold", color: "#FFF" }}>Forgot Username</Text>
              <Pressable onPress={() => setShowForgotUsername(false)} hitSlop={12}>
                <Ionicons name="close" size={24} color="#94A3B8" />
              </Pressable>
            </View>
            <Text style={{ fontSize: 14, fontFamily: "Inter_400Regular", color: "#94A3B8", marginBottom: 20, lineHeight: 20 }}>
              Enter the email address associated with your account. We'll send your username to that email.
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
                    <Text style={{ color: "#FFF", fontSize: 16, fontFamily: "Inter_600SemiBold" }}>Send Username</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  flex: {
    flex: 1,
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
    gap: 16,
    marginTop: 24,
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
    color: "rgba(255,255,255,0.25)",
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
