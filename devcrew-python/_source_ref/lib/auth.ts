import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { createAuthClient } from "better-auth/client";
import { eq } from "drizzle-orm";
import { db, users, type User } from "@/db";

export const SESSION_COOKIE = "devcrew_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // matches Better Auth's default 7-day session

// Better Auth client pointed at the hosted auth service. It only runs on the
// server: the session token lives in an HTTP-only cookie and never reaches page scripts.
export const authClient = createAuthClient({
  baseURL: process.env.AUTH_URL,
  fetchOptions: {
    headers: { "x-api-key": process.env.AUTH_PUBLISHABLE_KEY ?? "" },
  },
});

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image?: string | null;
};

export function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getUserFromToken(token: string): Promise<AuthUser | null> {
  const { data } = await authClient.getSession({ fetchOptions: bearer(token) });
  return data?.user ?? null;
}

// Validates the session cookie against the auth service, once per request.
export const getCurrentUser = cache(async (): Promise<AuthUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserFromToken(token);
});

// Saves the user to our database the first time they sign in or sign up.
export async function syncUser(user: AuthUser) {
  await db
    .insert(users)
    .values({
      authId: user.id,
      name: user.name || null,
      email: user.email.toLowerCase(),
      image: user.image ?? null,
    })
    .onConflictDoNothing();
}

// The signed-in user's row in our database, created on demand. Once per request.
export const getDbUser = cache(async (): Promise<User | null> => {
  const authUser = await getCurrentUser();
  if (!authUser) return null;

  const find = () => db.query.users.findFirst({ where: eq(users.authId, authUser.id) });
  const existing = await find();
  if (existing) return existing;

  await syncUser(authUser);
  return (await find()) ?? null;
});

// Only allow same-site relative paths as post-auth destinations.
export function safeRedirect(path: unknown, fallback = "/workspaces") {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    return fallback;
  }
  return path;
}
