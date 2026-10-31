import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db, workspaces, type Workspace } from "@/db";

export const WORKSPACE_COOKIE = "devcrew_workspace";

export async function listWorkspaces(ownerId: number) {
  return db.query.workspaces.findMany({
    where: eq(workspaces.ownerId, ownerId),
    orderBy: desc(workspaces.createdAt),
  });
}

export async function getWorkspace(ownerId: number, id: string): Promise<Workspace | null> {
  // Reject non-UUIDs before they reach Postgres, which would throw on the cast.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await db.query.workspaces.findFirst({
    where: and(eq(workspaces.id, id), eq(workspaces.ownerId, ownerId)),
  });
  return row ?? null;
}

// The workspace picked on /workspaces, falling back to the newest one.
export async function getCurrentWorkspace(ownerId: number): Promise<Workspace | null> {
  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  if (selected) {
    const workspace = await getWorkspace(ownerId, selected);
    if (workspace) return workspace;
  }
  const [newest] = await listWorkspaces(ownerId);
  return newest ?? null;
}

export async function setCurrentWorkspace(id: string) {
  (await cookies()).set(WORKSPACE_COOKIE, id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export function workspaceLogoUrl(workspace: Pick<Workspace, "id" | "logoKey">) {
  if (!workspace.logoKey) return null;
  // The key changes on every upload, so it doubles as a cache buster.
  return `/api/workspaces/${workspace.id}/logo?v=${encodeURIComponent(workspace.logoKey.split("/").pop() ?? "")}`;
}
