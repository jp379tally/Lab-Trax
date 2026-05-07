export function calculateLineTotal(quantity: number, unitPrice: string | number): string {
  return (quantity * Number(unitPrice)).toFixed(2);
}

export function sumMoney(values: (string | number)[]): string {
  return values.reduce<number>((acc, v) => acc + Number(v), 0).toFixed(2);
}
