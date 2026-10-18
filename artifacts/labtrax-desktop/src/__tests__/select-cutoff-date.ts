import { fireEvent, screen, within } from "@testing-library/react";

export async function selectCutoffDate(value: string) {
  const calendar = within(await screen.findByRole("dialog", { name: "Invoice cutoff date" }));
  const [year, month, day] = value.split("-").map(Number);
  fireEvent.change(calendar.getByRole("combobox", { name: "Choose the Year" }), { target: { value: String(year) } });
  fireEvent.change(calendar.getByRole("combobox", { name: "Choose the Month" }), { target: { value: String(month! - 1) } });
  const date = new Date(year!, month! - 1, day);
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);
  fireEvent.click(calendar.getByRole("button", { name: new RegExp(`${label.split(" ")[0]} ${day}(?:st|nd|rd|th), ${year}`) }));
}
