/** Encrypted objects in the dedicated namespace; never a path or legacy ZIP. */
export function isDatabaseProtectionObjectName(name: string): boolean {
  return /^(?:(?:chunk|records-(?:body|schema|inventory))-[a-f0-9]{64}|(?:records-)?(?:point|verified)-[0-9]{13}-[a-f0-9-]{36})\.enc$/.test(
    name,
  );
}
