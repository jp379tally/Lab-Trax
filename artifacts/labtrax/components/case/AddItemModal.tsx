import React from "react";
import {
  Modal,
  KeyboardAvoidingView,
  View,
  Text,
  Pressable,
  ScrollView,
  TextInput,
  Platform,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { CaseTypeValue, ToothType, SHADE_OPTIONS, Client, PricingTier } from "@/lib/data";
import { resolvePriceForCase } from "@/lib/pricing";

export type AddItemStep =
  | "caseType"
  | "toothChart"
  | "material"
  | "removableSubtype"
  | "removableMaterial"
  | "gingivaShade"
  | "applianceSubtype"
  | "applianceArch"
  | "applianceNightGuardType"
  | "applianceRetainerType"
  | "applianceNightGuard"
  | "applianceEssexTeeth"
  | "applianceEssexShade"
  | "complete";

export type AddItemModalProps = {
  visible: boolean;
  onClose: () => void;
  insetsBottom: number;
  showPrice: boolean;
  doctorName: string;
  clients: Client[];
  pricingTiers: PricingTier[];

  addItemStep: AddItemStep;
  setAddItemStep: React.Dispatch<React.SetStateAction<AddItemStep>>;

  itemCaseType: CaseTypeValue;
  setItemCaseType: React.Dispatch<React.SetStateAction<CaseTypeValue>>;

  itemSelectedTeeth: number[];
  setItemSelectedTeeth: React.Dispatch<React.SetStateAction<number[]>>;

  itemToothTypes: Record<number, ToothType>;
  setItemToothTypes: React.Dispatch<React.SetStateAction<Record<number, ToothType>>>;

  itemMaterial: string;
  setItemMaterial: React.Dispatch<React.SetStateAction<string>>;

  removableSubtype: string;
  setRemovableSubtype: React.Dispatch<React.SetStateAction<string>>;
  removableMaterial: string;
  setRemovableMaterial: React.Dispatch<React.SetStateAction<string>>;
  removableCustomMaterial: string;
  setRemovableCustomMaterial: React.Dispatch<React.SetStateAction<string>>;
  gingivaShade: string;
  setGingivaShade: React.Dispatch<React.SetStateAction<string>>;
  gingivaCustomNote: string;
  setGingivaCustomNote: React.Dispatch<React.SetStateAction<string>>;

  applianceSubtype: string;
  setApplianceSubtype: React.Dispatch<React.SetStateAction<string>>;
  applianceArch: "" | "Upper" | "Lower" | "Both";
  setApplianceArch: React.Dispatch<React.SetStateAction<"" | "Upper" | "Lower" | "Both">>;
  applianceVariant: string;
  setApplianceVariant: React.Dispatch<React.SetStateAction<string>>;
  setNightGuardType: React.Dispatch<React.SetStateAction<string>>;
  essexShade: string;
  setEssexShade: React.Dispatch<React.SetStateAction<string>>;

  itemBillableCount: number;
  itemCalculatedPrice: number;
  itemToothDisplay: string;

  handleItemToothTap: (num: number) => void;
  handleItemToothLongPress: (num: number) => void;
  handleSaveItem: () => void;

  // For inline appliance commits (subtypes that don't go through handleSaveItem):
  caseId: string;
  addCaseItem: (
    caseId: string,
    caseType: CaseTypeValue,
    teeth: number[],
    types: Record<number, ToothType>,
    material: string,
    extras?: { applianceSubType?: string; nightGuardType?: string },
  ) => void;
  addApplianceToInvoice: (subtype: string, variant: string, arch: string) => void;

  styles: Record<string, import("react-native").StyleProp<import("react-native").ViewStyle & import("react-native").TextStyle & import("react-native").ImageStyle>>;
};

export function AddItemModal(props: AddItemModalProps) {
  const {
    visible,
    onClose,
    insetsBottom,
    showPrice,
    doctorName,
    clients,
    pricingTiers,
    addItemStep,
    setAddItemStep,
    itemCaseType,
    setItemCaseType,
    itemSelectedTeeth,
    setItemSelectedTeeth,
    itemToothTypes,
    setItemToothTypes,
    itemMaterial,
    setItemMaterial,
    removableSubtype,
    setRemovableSubtype,
    removableMaterial,
    setRemovableMaterial,
    removableCustomMaterial,
    setRemovableCustomMaterial,
    gingivaShade,
    setGingivaShade,
    gingivaCustomNote,
    setGingivaCustomNote,
    applianceSubtype,
    setApplianceSubtype,
    applianceArch,
    setApplianceArch,
    applianceVariant,
    setApplianceVariant,
    setNightGuardType,
    essexShade,
    setEssexShade,
    itemBillableCount,
    itemCalculatedPrice,
    itemToothDisplay,
    handleItemToothTap,
    handleItemToothLongPress,
    handleSaveItem,
    caseId,
    addCaseItem,
    addApplianceToInvoice,
    styles,
  } = props;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.addItemOverlay}
      >
        <View style={[styles.addItemSheet, { paddingBottom: Platform.OS === "web" ? 34 : insetsBottom + 16 }]}>
          <View style={styles.modalHandle} />
          <View style={styles.addItemHeader}>
            <Pressable onPress={() => {
              if (addItemStep === "caseType") {
                onClose();
              } else if (addItemStep === "toothChart") {
                if (itemCaseType === "Removable") setAddItemStep("removableSubtype");
                else setAddItemStep("caseType");
              } else if (addItemStep === "material") {
                setAddItemStep("toothChart");
              } else if (addItemStep === "removableSubtype") {
                setAddItemStep("caseType");
              } else if (addItemStep === "removableMaterial") {
                if (removableSubtype === "Denture") setAddItemStep("removableSubtype");
                else setAddItemStep("toothChart");
              } else if (addItemStep === "gingivaShade") {
                setAddItemStep("removableMaterial");
              } else if (addItemStep === "applianceSubtype") {
                setAddItemStep("caseType");
              } else if (addItemStep === "applianceArch") {
                setAddItemStep("applianceSubtype");
              } else if (addItemStep === "applianceNightGuardType") {
                setAddItemStep("applianceArch");
              } else if (addItemStep === "applianceRetainerType") {
                setAddItemStep("applianceArch");
              } else if (addItemStep === "applianceNightGuard") {
                setAddItemStep("applianceSubtype");
              } else if (addItemStep === "applianceEssexTeeth") {
                setAddItemStep("applianceSubtype");
              } else if (addItemStep === "applianceEssexShade") {
                setAddItemStep("applianceEssexTeeth");
              } else {
                setAddItemStep("caseType");
              }
            }}>
              <Ionicons name={addItemStep === "caseType" ? "close" : "arrow-back"} size={24} color={Colors.light.textSecondary} />
            </Pressable>
            <Text style={styles.addItemTitle}>
              {addItemStep === "caseType" ? "Select Case Type" :
               addItemStep === "toothChart" ? "Select Teeth" :
               addItemStep === "material" ? "Select Material" :
               addItemStep === "removableSubtype" ? "Select Removable Type" :
               addItemStep === "removableMaterial" ? "Select Material" :
               addItemStep === "gingivaShade" ? "Select Gingiva Shade" :
               addItemStep === "applianceSubtype" ? "Select Appliance Type" :
               addItemStep === "applianceArch" ? "Select Arch" :
               addItemStep === "applianceNightGuardType" ? "Night Guard Type" :
               addItemStep === "applianceRetainerType" ? "Retainer Type" :
               addItemStep === "applianceNightGuard" ? "Night Guard Type" :
               addItemStep === "applianceEssexTeeth" ? "Select Teeth" :
               addItemStep === "applianceEssexShade" ? "Select Shade" : "Add Item"}
            </Text>
            <View style={{ width: 24 }} />
          </View>

          {addItemStep === "caseType" && (
            <View style={styles.addItemCaseTypeList}>
              {(["Restorative", "Removable", "Appliance", "Temporary"] as CaseTypeValue[]).map((type) => (
                <Pressable
                  key={type}
                  onPress={() => {
                    setItemCaseType(type);
                    if (type === "Restorative" || type === "Temporary") {
                      setAddItemStep("toothChart");
                    } else if (type === "Removable") {
                      setAddItemStep("removableSubtype");
                    } else if (type === "Appliance") {
                      setAddItemStep("applianceSubtype");
                    }
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    itemCaseType === type && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons
                      name={type === "Restorative" ? "construct" : type === "Removable" ? "swap-horizontal" : type === "Appliance" ? "hardware-chip" : "timer"}
                      size={20}
                      color={itemCaseType === type ? Colors.light.tint : Colors.light.textSecondary}
                    />
                  </View>
                  <Text style={[styles.addItemCaseTypeText, itemCaseType === type && styles.addItemCaseTypeTextSelected]}>
                    {type}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                </Pressable>
              ))}
            </View>
          )}

          {(addItemStep === "toothChart" || addItemStep === "applianceEssexTeeth") && (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
              <View style={styles.addItemSelectedType}>
                <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                <Text style={styles.addItemSelectedTypeText}>
                  {itemCaseType}{removableSubtype ? ` - ${removableSubtype}` : ""}{applianceSubtype ? ` - ${applianceSubtype}` : ""}
                </Text>
              </View>

              <View style={styles.aiToothChartPanel}>
                <View style={styles.aiToothChartHeader}>
                  <Text style={styles.aiToothChartTitle}>American Dental Numbering</Text>
                  {itemSelectedTeeth.length > 0 && (
                    <Pressable
                      onPress={() => { setItemSelectedTeeth([]); setItemToothTypes({}); }}
                      style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                    >
                      <Text style={styles.aiToothChartClear}>Clear</Text>
                    </Pressable>
                  )}
                </View>

                <View style={styles.aiToothChartLegend}>
                  <View style={styles.aiLegendItem}>
                    <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.tint }]} />
                    <Text style={styles.aiLegendText}>Normal</Text>
                  </View>
                  <View style={styles.aiLegendItem}>
                    <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.accent }]} />
                    <Text style={styles.aiLegendText}>Pontic</Text>
                  </View>
                  <View style={styles.aiLegendItem}>
                    <View style={[styles.aiLegendDot, { backgroundColor: Colors.light.error }]} />
                    <Text style={styles.aiLegendText}>Missing</Text>
                  </View>
                  <Text style={styles.aiLegendHint}>Hold to set type</Text>
                </View>

                <View style={{ alignItems: "center" as const, paddingVertical: 8, backgroundColor: "#FFFFFF", borderRadius: 12, overflow: "hidden" as const }}>
                  {(() => {
                    const IMG_W = 290;
                    const IMG_H = 345;
                    const TOOTH_SZ = 28;
                    const scale = IMG_W / 320;

                    const toothPositions: { num: number; x: number; y: number }[] = [
                      { num: 1, x: 26 * scale, y: 166 * scale },
                      { num: 2, x: 32 * scale, y: 132 * scale },
                      { num: 3, x: 42 * scale, y: 100 * scale },
                      { num: 4, x: 56 * scale, y: 72 * scale },
                      { num: 5, x: 74 * scale, y: 48 * scale },
                      { num: 6, x: 96 * scale, y: 28 * scale },
                      { num: 7, x: 122 * scale, y: 14 * scale },
                      { num: 8, x: 148 * scale, y: 8 * scale },
                      { num: 9, x: 174 * scale, y: 8 * scale },
                      { num: 10, x: 200 * scale, y: 14 * scale },
                      { num: 11, x: 226 * scale, y: 28 * scale },
                      { num: 12, x: 248 * scale, y: 48 * scale },
                      { num: 13, x: 266 * scale, y: 72 * scale },
                      { num: 14, x: 280 * scale, y: 100 * scale },
                      { num: 15, x: 290 * scale, y: 132 * scale },
                      { num: 16, x: 296 * scale, y: 166 * scale },
                      { num: 17, x: 296 * scale, y: 210 * scale },
                      { num: 18, x: 290 * scale, y: 244 * scale },
                      { num: 19, x: 280 * scale, y: 274 * scale },
                      { num: 20, x: 266 * scale, y: 300 * scale },
                      { num: 21, x: 248 * scale, y: 322 * scale },
                      { num: 22, x: 226 * scale, y: 340 * scale },
                      { num: 23, x: 200 * scale, y: 352 * scale },
                      { num: 24, x: 174 * scale, y: 360 * scale },
                      { num: 25, x: 148 * scale, y: 360 * scale },
                      { num: 26, x: 122 * scale, y: 352 * scale },
                      { num: 27, x: 96 * scale, y: 340 * scale },
                      { num: 28, x: 74 * scale, y: 322 * scale },
                      { num: 29, x: 56 * scale, y: 300 * scale },
                      { num: 30, x: 42 * scale, y: 274 * scale },
                      { num: 31, x: 32 * scale, y: 244 * scale },
                      { num: 32, x: 26 * scale, y: 210 * scale },
                    ];

                    const normalColor = Colors.light.tint;
                    const ponticColor = Colors.light.accent;
                    const missingColor = Colors.light.error;

                    return (
                      <View style={{ width: IMG_W, height: IMG_H, position: "relative" }}>
                        <Image
                          source={require("@/assets/images/tooth-chart.jpeg")}
                          style={{ width: IMG_W, height: IMG_H, position: "absolute", top: 0, left: 0 }}
                          contentFit="contain"
                        />
                        {toothPositions.map(({ num, x, y }) => {
                          const isSelected = itemSelectedTeeth.includes(num);
                          const tType = itemToothTypes[num] || "normal";
                          let bgColor = "transparent";
                          let borderCol = "transparent";
                          let textColor = "transparent";
                          if (isSelected) {
                            if (tType === "normal") { bgColor = normalColor + "CC"; borderCol = normalColor; textColor = "#FFF"; }
                            else if (tType === "bridge") { bgColor = ponticColor + "CC"; borderCol = ponticColor; textColor = "#FFF"; }
                            else if (tType === "missing") { bgColor = "#FEE2E2CC"; borderCol = missingColor; textColor = missingColor; }
                          }
                          return (
                            <Pressable
                              key={num}
                              onPress={() => handleItemToothTap(num)}
                              onLongPress={() => handleItemToothLongPress(num)}
                              delayLongPress={400}
                              style={{
                                position: "absolute",
                                left: x - TOOTH_SZ / 2,
                                top: y - TOOTH_SZ / 2,
                                width: TOOTH_SZ,
                                height: TOOTH_SZ,
                                borderRadius: TOOTH_SZ / 2,
                                backgroundColor: bgColor,
                                borderWidth: isSelected ? 2 : 0,
                                borderColor: borderCol,
                                alignItems: "center" as const,
                                justifyContent: "center" as const,
                                zIndex: 10,
                              }}
                            >
                              {isSelected && tType === "missing" ? (
                                <View style={styles.aiToothMissingWrap}>
                                  <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: missingColor }}>{num}</Text>
                                  <View style={styles.aiToothXOverlay}>
                                    <Ionicons name="close" size={12} color={missingColor} />
                                  </View>
                                </View>
                              ) : isSelected ? (
                                <Text style={{ fontSize: 10, fontFamily: "Inter_700Bold", color: textColor }}>{num}</Text>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    );
                  })()}
                </View>

                {itemSelectedTeeth.length > 0 && (
                  <View style={styles.aiToothChartSummary}>
                    <View style={styles.aiToothSummaryRow}>
                      <Ionicons name="checkmark-circle" size={16} color={Colors.light.tint} />
                      <Text style={styles.aiToothChartSummaryText}>{itemToothDisplay}</Text>
                    </View>
                  </View>
                )}
              </View>

              {(itemCaseType === "Restorative" || itemCaseType === "Temporary") && itemSelectedTeeth.length > 0 && showPrice && (
                <View style={styles.aiPricingRow}>
                  <Text style={styles.aiPricingLabel}>
                    {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${resolvePriceForCase(itemMaterial, itemCaseType, doctorName, clients, pricingTiers)}/{itemMaterial}
                  </Text>
                  <Text style={styles.aiPricingTotal}>${itemCalculatedPrice.toLocaleString()}</Text>
                </View>
              )}

              <Pressable
                onPress={() => {
                  if (addItemStep === "applianceEssexTeeth") {
                    setAddItemStep("applianceEssexShade");
                  } else if (itemCaseType === "Restorative" || itemCaseType === "Temporary") {
                    setAddItemStep("material");
                  } else if (itemCaseType === "Removable") {
                    setAddItemStep("removableMaterial");
                  }
                }}
                style={({ pressed }) => [
                  styles.aiSaveItemBtn,
                  { backgroundColor: Colors.light.tint },
                  itemSelectedTeeth.length === 0 && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
                disabled={itemSelectedTeeth.length === 0}
              >
                <Ionicons name="arrow-forward" size={20} color="#FFF" />
                <Text style={styles.aiSaveItemBtnText}>Next</Text>
              </Pressable>
            </ScrollView>
          )}

          {addItemStep === "material" && (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
              <View style={styles.addItemSelectedType}>
                <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                <Text style={styles.addItemSelectedTypeText}>{itemCaseType} - {itemToothDisplay}</Text>
              </View>

              <View style={styles.aiMaterialSection}>
                <Text style={styles.aiMaterialLabel}>Material</Text>
                <View style={styles.aiMaterialSelector}>
                  {["Zirconia", "E.max", "PFM", "Gold", "Semi Precious", "Full Cast", "Diagnostic Wax Up", "Other"].map((m) => (
                    <Pressable
                      key={m}
                      onPress={() => setItemMaterial(m)}
                      style={[
                        styles.aiMaterialChip,
                        itemMaterial === m && styles.aiMaterialChipActive,
                      ]}
                    >
                      <Text style={[
                        styles.aiMaterialText,
                        itemMaterial === m && styles.aiMaterialTextActive,
                      ]}>{m}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              {itemSelectedTeeth.length > 0 && showPrice && (
                <View style={styles.aiPricingRow}>
                  <Text style={styles.aiPricingLabel}>
                    {itemBillableCount} billable {itemBillableCount === 1 ? "tooth" : "teeth"} x ${resolvePriceForCase(itemMaterial, itemCaseType, doctorName, clients, pricingTiers)}/{itemMaterial}
                  </Text>
                  <Text style={styles.aiPricingTotal}>${itemCalculatedPrice.toLocaleString()}</Text>
                </View>
              )}

              <Pressable
                onPress={handleSaveItem}
                style={({ pressed }) => [
                  styles.aiSaveItemBtn,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={styles.aiSaveItemBtnText}>Complete</Text>
              </Pressable>
            </ScrollView>
          )}

          {addItemStep === "removableSubtype" && (
            <View style={styles.addItemCaseTypeList}>
              {["Full Denture", "Partial", "Nesbit", "Interim Partial", "Immediate Partial", "Immediate Denture"].map((sub) => {
                const iconMap: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = { "Full Denture": "apps", "Partial": "pie-chart", "Nesbit": "git-branch", "Interim Partial": "time", "Immediate Partial": "flash", "Immediate Denture": "speedometer" };
                const isDenture = sub === "Full Denture" || sub === "Immediate Denture";
                return (
                <Pressable
                  key={sub}
                  onPress={() => {
                    setRemovableSubtype(sub);
                    if (isDenture) {
                      setAddItemStep("removableMaterial");
                    } else {
                      setAddItemStep("toothChart");
                    }
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    removableSubtype === sub && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons
                      name={iconMap[sub] || "ellipsis-horizontal"}
                      size={20}
                      color={removableSubtype === sub ? Colors.light.tint : Colors.light.textSecondary}
                    />
                  </View>
                  <Text style={[styles.addItemCaseTypeText, removableSubtype === sub && styles.addItemCaseTypeTextSelected]}>
                    {sub}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                </Pressable>
                );
              })}
            </View>
          )}

          {addItemStep === "removableMaterial" && (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
              <View style={styles.addItemSelectedType}>
                <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                <Text style={styles.addItemSelectedTypeText}>Removable - {removableSubtype}</Text>
              </View>

              <View style={styles.addItemCaseTypeList}>
                {["Acrylic", "Flexible", "Cast Metal", "Other"].map((mat) => (
                  <Pressable
                    key={mat}
                    onPress={() => {
                      setRemovableMaterial(mat);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      removableMaterial === mat && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={mat === "Acrylic" ? "color-palette" : mat === "Flexible" ? "water" : mat === "Cast Metal" ? "hammer" : "ellipsis-horizontal"}
                        size={20}
                        color={removableMaterial === mat ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, removableMaterial === mat && styles.addItemCaseTypeTextSelected]}>
                      {mat}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {removableMaterial === "Other" && (
                <TextInput
                  style={{ borderWidth: 1, borderColor: "#E0E0E0", borderRadius: 8, padding: 12, marginTop: 12, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                  placeholder="Describe custom material..."
                  placeholderTextColor={Colors.light.textTertiary}
                  value={removableCustomMaterial}
                  onChangeText={setRemovableCustomMaterial}
                />
              )}

              <Pressable
                onPress={() => setAddItemStep("gingivaShade")}
                style={({ pressed }) => [
                  styles.aiSaveItemBtn,
                  { backgroundColor: Colors.light.tint, marginTop: 16 },
                  !removableMaterial && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
                disabled={!removableMaterial}
              >
                <Ionicons name="arrow-forward" size={20} color="#FFF" />
                <Text style={styles.aiSaveItemBtnText}>Next</Text>
              </Pressable>
            </ScrollView>
          )}

          {addItemStep === "gingivaShade" && (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
              <View style={styles.addItemSelectedType}>
                <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                <Text style={styles.addItemSelectedTypeText}>Removable - {removableSubtype} - {removableMaterial === "Other" && removableCustomMaterial ? removableCustomMaterial : removableMaterial}</Text>
              </View>

              <View style={styles.addItemCaseTypeList}>
                {["Standard Pink Light", "Light Meharry", "Dark Meharry", "Other"].map((shade) => (
                  <Pressable
                    key={shade}
                    onPress={() => {
                      setGingivaShade(shade);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={({ pressed }) => [
                      styles.addItemCaseTypeItem,
                      gingivaShade === shade && styles.addItemCaseTypeItemSelected,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <View style={styles.addItemCaseTypeIcon}>
                      <Ionicons
                        name={shade === "Other" ? "ellipsis-horizontal" : "color-fill"}
                        size={20}
                        color={gingivaShade === shade ? Colors.light.tint : Colors.light.textSecondary}
                      />
                    </View>
                    <Text style={[styles.addItemCaseTypeText, gingivaShade === shade && styles.addItemCaseTypeTextSelected]}>
                      {shade}
                    </Text>
                  </Pressable>
                ))}
              </View>

              {gingivaShade === "Other" && (
                <TextInput
                  style={{ borderWidth: 1, borderColor: "#E0E0E0", borderRadius: 8, padding: 12, marginTop: 12, fontSize: 14, fontFamily: "Inter_400Regular", color: Colors.light.text }}
                  placeholder="Describe custom gingiva shade..."
                  placeholderTextColor={Colors.light.textTertiary}
                  value={gingivaCustomNote}
                  onChangeText={setGingivaCustomNote}
                />
              )}

              {gingivaShade === "Other" && gingivaCustomNote.trim().length > 0 && (
                <Pressable
                  onPress={() => {
                    if (gingivaCustomNote.trim()) {
                      setGingivaShade(gingivaCustomNote.trim());
                    }
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  style={({ pressed }) => [
                    styles.aiSaveItemBtn,
                    { backgroundColor: "#F5A623", marginTop: 12 },
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <Ionicons name="document-text" size={18} color="#FFF" />
                  <Text style={styles.aiSaveItemBtnText}>Add to Case Notes</Text>
                </Pressable>
              )}

              <Pressable
                onPress={handleSaveItem}
                style={({ pressed }) => [
                  styles.aiSaveItemBtn,
                  { marginTop: 16 },
                  !gingivaShade && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
                disabled={!gingivaShade}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={styles.aiSaveItemBtnText}>Complete</Text>
              </Pressable>
            </ScrollView>
          )}

          {addItemStep === "applianceSubtype" && (
            <View style={styles.addItemCaseTypeList}>
              {[
                { label: "Night Guard", icon: "moon" as const },
                { label: "Retainer", icon: "fitness" as const },
                { label: "Snore Guard", icon: "bed" as const },
                { label: "Sports Guard", icon: "shield" as const },
              ].map(({ label, icon }) => (
                <Pressable
                  key={label}
                  onPress={() => {
                    setApplianceSubtype(label);
                    setApplianceArch("");
                    setApplianceVariant("");
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    if (label === "Night Guard" || label === "Retainer") {
                      setAddItemStep("applianceArch");
                    } else {
                      addCaseItem(caseId, itemCaseType, [], {}, label, { applianceSubType: label });
                      addApplianceToInvoice(label, "", "");
                      if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                      onClose();
                    }
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    applianceSubtype === label && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons name={icon} size={20} color={applianceSubtype === label ? Colors.light.tint : Colors.light.textSecondary} />
                  </View>
                  <Text style={[styles.addItemCaseTypeText, applianceSubtype === label && styles.addItemCaseTypeTextSelected]}>
                    {label}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                </Pressable>
              ))}
            </View>
          )}

          {addItemStep === "applianceArch" && (
            <View style={styles.addItemCaseTypeList}>
              <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                  {applianceSubtype} · Select arch
                </Text>
              </View>
              {(["Upper", "Lower", "Both"] as const).map((arch) => (
                <Pressable
                  key={arch}
                  onPress={() => {
                    setApplianceArch(arch);
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    if (applianceSubtype === "Night Guard") {
                      setAddItemStep("applianceNightGuardType");
                    } else {
                      setAddItemStep("applianceRetainerType");
                    }
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    applianceArch === arch && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons
                      name={arch === "Upper" ? "arrow-up-circle" : arch === "Lower" ? "arrow-down-circle" : "swap-vertical"}
                      size={20}
                      color={applianceArch === arch ? Colors.light.tint : Colors.light.textSecondary}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.addItemCaseTypeText, applianceArch === arch && styles.addItemCaseTypeTextSelected]}>
                      {arch}
                    </Text>
                    {arch === "Both" && (
                      <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>
                        Bills as 2 line items
                      </Text>
                    )}
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={Colors.light.textTertiary} />
                </Pressable>
              ))}
            </View>
          )}

          {addItemStep === "applianceNightGuardType" && (
            <View style={styles.addItemCaseTypeList}>
              <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                  Night Guard · {applianceArch} · Select type
                </Text>
              </View>
              {[
                { label: "Hard", icon: "shield" as const, desc: "Rigid acrylic" },
                { label: "Soft", icon: "water" as const, desc: "Flexible EVA" },
                { label: "Hard/Soft", icon: "shield-half" as const, desc: "Dual-laminate" },
              ].map(({ label, icon, desc }) => (
                <Pressable
                  key={label}
                  onPress={() => {
                    setApplianceVariant(label);
                    setNightGuardType(label);
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    addCaseItem(caseId, itemCaseType, [], {}, "Night Guard", { applianceSubType: "Night Guard", nightGuardType: label });
                    addApplianceToInvoice("Night Guard", label, applianceArch);
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    applianceVariant === label && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons name={icon} size={20} color={applianceVariant === label ? Colors.light.tint : Colors.light.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.addItemCaseTypeText, applianceVariant === label && styles.addItemCaseTypeTextSelected]}>
                      {label}
                    </Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>{desc}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {addItemStep === "applianceRetainerType" && (
            <View style={styles.addItemCaseTypeList}>
              <View style={{ paddingHorizontal: 4, paddingBottom: 8 }}>
                <Text style={{ fontSize: 13, fontFamily: "Inter_500Medium", color: Colors.light.textSecondary }}>
                  Retainer · {applianceArch} · Select type
                </Text>
              </View>
              {[
                { label: "Hawley", icon: "construct" as const, desc: "Wire + acrylic" },
                { label: "Hard", icon: "layers" as const, desc: "Clear rigid" },
                { label: "Lingual", icon: "git-commit" as const, desc: "Fixed wire" },
              ].map(({ label, icon, desc }) => (
                <Pressable
                  key={label}
                  onPress={() => {
                    setApplianceVariant(label);
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    addCaseItem(caseId, itemCaseType, [], {}, "Retainer", { applianceSubType: "Retainer", nightGuardType: label });
                    addApplianceToInvoice("Retainer", label, applianceArch);
                    if (Platform.OS !== "web") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.addItemCaseTypeItem,
                    applianceVariant === label && styles.addItemCaseTypeItemSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.addItemCaseTypeIcon}>
                    <Ionicons name={icon} size={20} color={applianceVariant === label ? Colors.light.tint : Colors.light.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.addItemCaseTypeText, applianceVariant === label && styles.addItemCaseTypeTextSelected]}>
                      {label}
                    </Text>
                    <Text style={{ fontSize: 11, fontFamily: "Inter_400Regular", color: Colors.light.textTertiary, marginTop: 1 }}>{desc}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}

          {addItemStep === "applianceEssexShade" && (
            <ScrollView showsVerticalScrollIndicator={false} style={styles.addItemToothScroll}>
              <View style={styles.addItemSelectedType}>
                <Ionicons name="pricetag" size={14} color={Colors.light.tint} />
                <Text style={styles.addItemSelectedTypeText}>Appliance - Essex - {itemToothDisplay}</Text>
              </View>

              <View style={{ flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 }}>
                {SHADE_OPTIONS.map((shade) => (
                  <Pressable
                    key={shade}
                    onPress={() => {
                      setEssexShade(shade);
                      if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }}
                    style={[
                      styles.aiMaterialChip,
                      { flex: undefined, paddingHorizontal: 14, minWidth: 60 },
                      essexShade === shade && styles.aiMaterialChipActive,
                    ]}
                  >
                    <Text style={[
                      styles.aiMaterialText,
                      essexShade === shade && styles.aiMaterialTextActive,
                    ]}>{shade}</Text>
                  </Pressable>
                ))}
              </View>

              <Pressable
                onPress={handleSaveItem}
                style={({ pressed }) => [
                  styles.aiSaveItemBtn,
                  { marginTop: 16 },
                  !essexShade && { opacity: 0.5 },
                  pressed && { opacity: 0.85 },
                ]}
                disabled={!essexShade}
              >
                <Ionicons name="checkmark" size={20} color="#FFF" />
                <Text style={styles.aiSaveItemBtnText}>Complete</Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
