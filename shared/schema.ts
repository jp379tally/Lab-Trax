import { sql } from "drizzle-orm";
import { pgTable, text, varchar, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  email: text("email"),
  phone: text("phone"),
  userType: text("user_type").default("lab"),
  role: text("role").default("user"),
  licenseNumber: text("license_number"),
  practiceName: text("practice_name"),
  doctorName: text("doctor_name"),
  practiceAddress: text("practice_address"),
  practicePhone: text("practice_phone"),
  phoneContactName: text("phone_contact_name"),
  accountNumber: text("account_number"),
  wantsUpdates: boolean("wants_updates").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
