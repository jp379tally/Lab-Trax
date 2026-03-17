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
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as LocalAuthentication from "expo-local-authentication";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@/lib/auth-context";
import { apiRequest } from "@/lib/query-client";
import { generateId, GroupJoinRequest, Group } from "@/lib/data";
import Colors from "@/constants/colors";

type SignUpStep = "credentials" | "user_type" | "lab_name" | "lab_info" | "license" | "practice_info" | "email_verify" | "updates_opt_in" | "phone_entry" | "phone_verify" | "phone_contact_name" | "role_select" | "join_group" | "hipaa_disclaimer" | "complete";

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
  const { login, loginWithBiometric, register, registeredUsers } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string>("Biometric");

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
  const [matchingLabGroup, setMatchingLabGroup] = useState<Group | null>(null);
  const [labJoinRequestSent, setLabJoinRequestSent] = useState(false);
  const [checkingLabName, setCheckingLabName] = useState(false);

  const codeInputRefs = useRef<(TextInput | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkBiometricAvailability();
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
    setSignUpStep("credentials");
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
    const result = await login(username.trim(), password.trim());
    setIsLoggingIn(false);
    if (!result.success) setError(result.error || "Login failed.");
  }

  async function handleCredentialsNext() {
    if (!signUpUsername.trim()) {
      setSignUpError("Please enter a username.");
      return;
    }
    if (signUpUsername.trim().length < 3) {
      setSignUpError("Username must be at least 3 characters.");
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
    } catch {
      setSignUpStep("phone_contact_name");
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
    } catch {
      setSignUpStep("phone_contact_name");
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
    } catch {
      setSignUpStep("updates_opt_in");
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
    } catch {
      setSignUpStep("updates_opt_in");
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

      try {
        await apiRequest("POST", "/api/register", { username: signUpUsername.trim() });
      } catch {}

      const isLab = (userType || "provider") === "lab";
      const resolvedAddress = isLab
        ? [labStreet.trim(), labCity.trim(), labState.trim(), labZip.trim()].filter(Boolean).join(", ")
        : [streetAddress.trim(), city.trim(), zipCode.trim()].filter(Boolean).join(", ");
      const resolvedPhone = isLab ? labPhone.trim() : practicePhone.trim();
      const resolvedEmail = isLab ? (labEmail.trim() || signUpEmail.trim()) : signUpEmail.trim();

      if (selectedRole === "admin") {
        const now = Date.now();
        const newGroup = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          name: signUpUsername.trim(),
          type: isLab ? "lab" : "provider",
          address: resolvedAddress,
          members: [{
            userId: Date.now().toString() + Math.random().toString(36).substr(2, 9),
            username: signUpUsername.trim(),
            role: "admin",
            joinedAt: now,
          }],
          createdAt: now,
        };
        try {
          const existingGroupsRaw = await AsyncStorage.getItem("@drivesync_groups");
          const existingGroups = existingGroupsRaw ? JSON.parse(existingGroupsRaw) : [];
          existingGroups.push(newGroup);
          await AsyncStorage.setItem("@drivesync_groups", JSON.stringify(existingGroups));
        } catch {}
        await AsyncStorage.setItem("@drivesync_pending_group", JSON.stringify({
          name: signUpUsername.trim(),
          type: isLab ? "lab" : "provider",
          address: resolvedAddress,
          username: signUpUsername.trim(),
          role: "admin",
        }));
      } else if (practiceName.trim() && streetAddress.trim()) {
        await AsyncStorage.setItem("@drivesync_pending_group", JSON.stringify({
          name: practiceName.trim(),
          type: isLab ? "lab" : "provider",
          address: resolvedAddress,
          username: signUpUsername.trim(),
          role: selectedRole || "user",
        }));
      }
      if (userType === "provider") {
        const pendingClient = {
          practiceName: practiceName.trim() || doctorName.trim(),
          leadDoctor: doctorName.trim() ? `Dr. ${doctorName.trim()} (${acctNum})` : signUpUsername.trim(),
          phone: practicePhone.trim(),
          email: signUpEmail.trim(),
          address: [streetAddress.trim(), city.trim(), zipCode.trim()].filter(Boolean).join(", "),
          tier: "Standard",
          discountRate: 0,
        };
        await AsyncStorage.setItem("@drivesync_pending_client", JSON.stringify(pendingClient));
      }

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
      });
      if (!result.success) {
        setSignUpError(result.error || "Registration failed.");
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
            showsVerticalScrollIndicator={false}
          >
            <Pressable
              onPress={() => {
                setSignUpError(null);
                if (signUpStep === "credentials") {
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

  async function checkLabName() {
    if (!labName.trim()) {
      setSignUpError("Please enter a lab name.");
      return;
    }
    setCheckingLabName(true);
    setSignUpError(null);
    try {
      const stored = await AsyncStorage.getItem("@drivesync_groups");
      const existingGroups: Group[] = stored ? JSON.parse(stored) : [];
      const match = existingGroups.find(
        (g) => g.name.toLowerCase().trim() === labName.toLowerCase().trim() && g.type === "lab"
      );
      if (match) {
        setMatchingLabGroup(match);
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
      const adminMember = matchingLabGroup.members.find((m) => m.role === "admin");
      if (!adminMember) {
        setSignUpError("This lab doesn't have an admin yet. Please continue with a new account.");
        return;
      }
      const stored = await AsyncStorage.getItem("@drivesync_group_join_requests");
      const existing: GroupJoinRequest[] = stored ? JSON.parse(stored) : [];
      const alreadyPending = existing.find(
        (r) =>
          r.requestingUsername.toLowerCase() === signUpUsername.trim().toLowerCase() &&
          r.targetAdminUsername.toLowerCase() === adminMember.username.toLowerCase() &&
          r.status === "pending"
      );
      if (alreadyPending) {
        setSignUpError("You already have a pending request to join this lab.");
        return;
      }
      const request: GroupJoinRequest = {
        id: generateId(),
        requestingUsername: signUpUsername.trim(),
        targetAdminUsername: adminMember.username,
        message: `${signUpUsername.trim()} would like to join ${matchingLabGroup.name}.`,
        status: "pending",
        createdAt: Date.now(),
      };
      const updated = [...existing, request];
      await AsyncStorage.setItem("@drivesync_group_join_requests", JSON.stringify(updated));
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

        {!matchingLabGroup ? (
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
          </>
        ) : !labJoinRequestSent ? (
          <View style={{ gap: 16 }}>
            <View style={{ backgroundColor: "rgba(59,130,246,0.1)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 14, padding: 20, alignItems: "center" }}>
              <Ionicons name="business" size={32} color="#3B82F6" style={{ marginBottom: 8 }} />
              <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF", textAlign: "center", marginBottom: 4 }}>
                "{matchingLabGroup.name}" already exists
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
          </View>
        ) : (
          <View style={{ alignItems: "center", paddingVertical: 20, gap: 12 }}>
            <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "rgba(16,185,129,0.2)", justifyContent: "center", alignItems: "center" }}>
              <Ionicons name="checkmark-circle" size={36} color="#10B981" />
            </View>
            <Text style={{ fontSize: 16, fontFamily: "Inter_600SemiBold", color: "#FFF" }}>Request Sent</Text>
            <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "rgba(255,255,255,0.6)", textAlign: "center", lineHeight: 18 }}>
              Your request to join {matchingLabGroup.name} has been sent to the lab admin. You'll be notified when they respond.
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
          onPress={() => {
            if (!practiceName.trim() || !doctorName.trim() || !streetAddress.trim() || !city.trim() || !zipCode.trim() || !practicePhone.trim()) {
              setSignUpError("All fields are required.");
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
              placeholder="Username"
              placeholderTextColor="rgba(255,255,255,0.3)"
              autoCapitalize="none"
              autoCorrect={false}
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
        <View
          style={[
            styles.content,
            {
              paddingTop: Platform.OS === "web" ? 67 + 40 : insets.top + 40,
              paddingBottom: Platform.OS === "web" ? 34 + 20 : insets.bottom + 20,
            },
          ]}
        >
          <View style={styles.logoSection}>
            <View style={styles.logoContainer}>
              <LinearGradient
                colors={[Colors.light.tint, "#3B82F6"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.logoGradient}
              >
                <Ionicons name="flask" size={36} color="#FFF" />
              </LinearGradient>
            </View>
            <Text style={styles.appName}>LabTrax</Text>
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
            <View style={styles.footer}>
              <Text style={styles.footerText}>Secure Access Only</Text>
              <Ionicons name="shield-checkmark" size={14} color="rgba(255,255,255,0.25)" />
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    flex: 1,
    justifyContent: "space-between",
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
