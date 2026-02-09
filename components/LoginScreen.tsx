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
import * as Haptics from "expo-haptics";
import { useAuth } from "@/lib/auth-context";
import { getApiUrl } from "@/lib/query-client";
import Colors from "@/constants/colors";

type SignUpStep = "credentials" | "updates_opt_in" | "phone_entry" | "phone_verify" | "email_verify" | "complete";

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
  const { login, register } = useAuth();
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

  const codeInputRefs = useRef<(TextInput | null)[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    checkBiometricsAndPrompt();
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
  }

  function switchToSignIn() {
    setMode("signin");
    setUsername("");
    setPassword("");
    setError(null);
    setSignUpError(null);
  }

  async function checkBiometricsAndPrompt() {
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
        await new Promise((r) => setTimeout(r, 600));
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: "Sign in to DriveSync Lab",
          fallbackLabel: "Use password",
          disableDeviceFallback: false,
        });
        if (result.success) {
          setIsLoggingIn(true);
          const res = await login("admin", "123");
          setIsLoggingIn(false);
          if (!res.success) setError(res.error || "Authentication failed.");
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
        const res = await login("admin", "123");
        setIsLoggingIn(false);
        if (!res.success) setError(res.error || "Authentication failed.");
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
    setSignUpLoading(true);

    try {
      const apiUrl = getApiUrl();
      const res = await fetch(new URL("/api/check-username", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: signUpUsername.trim() }),
      });
      const data = await res.json();

      if (!data.available) {
        setSignUpError("Username taken");
        setSignUpLoading(false);
        return;
      }
    } catch {
      setSignUpError("Could not verify username. Please try again.");
      setSignUpLoading(false);
      return;
    }

    setSignUpLoading(false);
    setSignUpStep("updates_opt_in");
  }

  function handleUpdatesChoice(wants: boolean) {
    setWantsUpdates(wants);
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (wants) {
      setSignUpStep("phone_entry");
    } else {
      sendEmailCode();
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
      const apiUrl = getApiUrl();
      await fetch(new URL("/api/send-phone-code", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: signUpPhone.trim() }),
      });
      setCodeResendTimer(60);
      setSignUpStep("phone_verify");
      setPhoneCode("");
    } catch {
      setSignUpError("Failed to send code. Please try again.");
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
      const apiUrl = getApiUrl();
      const res = await fetch(new URL("/api/verify-phone-code", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: signUpPhone.trim(), code: phoneCode }),
      });
      const data = await res.json();
      if (data.verified) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        sendEmailCode();
      } else {
        setSignUpError(data.error || "Incorrect code.");
      }
    } catch {
      setSignUpError("Verification failed. Please try again.");
    }
    setSignUpLoading(false);
  }

  async function sendEmailCode() {
    setCodeSending(true);
    setSignUpError(null);
    try {
      const apiUrl = getApiUrl();
      await fetch(new URL("/api/send-email-code", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signUpEmail.trim() }),
      });
      setCodeResendTimer(60);
      setSignUpStep("email_verify");
      setEmailCode("");
    } catch {
      setSignUpError("Failed to send verification email. Please try again.");
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
      const apiUrl = getApiUrl();
      const res = await fetch(new URL("/api/verify-email-code", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signUpEmail.trim(), code: emailCode }),
      });
      const data = await res.json();
      if (data.verified) {
        if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await completeRegistration();
      } else {
        setSignUpError(data.error || "Incorrect code.");
      }
    } catch {
      setSignUpError("Verification failed. Please try again.");
    }
    setSignUpLoading(false);
  }

  async function completeRegistration() {
    setSignUpLoading(true);
    try {
      const apiUrl = getApiUrl();
      await fetch(new URL("/api/register", apiUrl).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: signUpUsername.trim() }),
      });

      const result = await register({
        username: signUpUsername.trim(),
        password: signUpPassword,
        email: signUpEmail.trim(),
        phone: wantsUpdates ? signUpPhone.trim() : undefined,
        wantsUpdates,
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
                if (signUpStep === "credentials") {
                  switchToSignIn();
                } else if (signUpStep === "updates_opt_in") {
                  setSignUpStep("credentials");
                  setSignUpError(null);
                } else if (signUpStep === "phone_entry") {
                  setSignUpStep("updates_opt_in");
                  setSignUpError(null);
                } else if (signUpStep === "phone_verify") {
                  setSignUpStep("phone_entry");
                  setSignUpError(null);
                } else if (signUpStep === "email_verify") {
                  if (wantsUpdates) {
                    setSignUpStep("phone_verify");
                  } else {
                    setSignUpStep("updates_opt_in");
                  }
                  setSignUpError(null);
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
                {signUpStep === "updates_opt_in" && "Stay connected with your lab"}
                {signUpStep === "phone_entry" && "Enter your phone number"}
                {signUpStep === "phone_verify" && "Verify your phone number"}
                {signUpStep === "email_verify" && "Verify your email address"}
              </Text>
            </View>

            {signUpStep === "credentials" && renderCredentialsStep()}
            {signUpStep === "updates_opt_in" && renderUpdatesOptIn()}
            {signUpStep === "phone_entry" && renderPhoneEntry()}
            {signUpStep === "phone_verify" && renderPhoneVerify()}
            {signUpStep === "email_verify" && renderEmailVerify()}

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
              {["credentials", "updates_opt_in", "phone_verify", "email_verify"].map((s, i) => {
                const steps = wantsUpdates
                  ? ["credentials", "updates_opt_in", "phone_entry", "phone_verify", "email_verify"]
                  : ["credentials", "updates_opt_in", "email_verify"];
                const currentIdx = steps.indexOf(signUpStep);
                const stepIdx = steps.indexOf(s as any);
                const isActive = stepIdx <= currentIdx;
                if (stepIdx === -1) return null;
                return (
                  <View
                    key={s}
                    style={[styles.stepDot, isActive && styles.stepDotActive]}
                  />
                );
              })}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
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
              <Text style={styles.loginBtnText}>Verify & Create Account</Text>
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
            <Text style={styles.appName}>DriveSync Lab</Text>
            <Text style={styles.appTagline}>Dental Laboratory Management</Text>
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
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 28,
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
});
