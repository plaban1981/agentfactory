import "server-only";

import { eq } from "drizzle-orm";
import { db, githubConnections, type GithubConnection } from "@/db";
import { decrypt } from "@/lib/crypto";

const API = "https://api.github.com";

// `repo` lets agents read and push to private repositories; `read:user` identifies the account.
export const GITHUB_SCOPES = "repo read:user";

// Short-lived cookie holding the OAuth `state` while the user is on github.com.
export const GITHUB_STATE_COOKIE = "devcrew_github_oauth";

export type GithubRepo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  ownerAvatarUrl: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  language: string | null;
  updatedAt: string;
};

type ApiRepo = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; avatar_url: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  language: string | null;
  updated_at: string;
};

export class GithubAuthError extends Error {}

// A non-2xx answer other than 401. `body` is GitHub's error message, when it sent one.
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string | null,
  ) {
    super(`GitHub API ${path} failed with ${status}${body ? `: ${body}` : ""}`);
    this.name = "GithubApiError";
  }
}

export async function githubFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      ...init?.headers,
    },
    cache: "no-store",
  });
  if (res.status === 401) throw new GithubAuthError("GitHub access was revoked. Reconnect your account.");
  if (!res.ok) {
    const { message } = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GithubApiError(res.status, path, typeof message === "string" ? message.slice(0, 300) : null);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function toRepo(r: ApiRepo): GithubRepo {
  return {
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    owner: r.owner.login,
    ownerAvatarUrl: r.owner.avatar_url,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    language: r.language,
    updatedAt: r.updated_at,
  };
}

export async function getGithubConnection(userId: number): Promise<GithubConnection | null> {
  return (await db.query.githubConnections.findFirst({ where: eq(githubConnections.userId, userId) })) ?? null;
}

export function connectionToken(connection: GithubConnection) {
  return decrypt(connection.accessToken);
}

// Most recently updated repositories the user can access, capped at 300.
export async function listRepos(token: string): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await githubFetch<ApiRepo[]>(
      token,
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`,
    );
    repos.push(...batch.map(toRepo));
    if (batch.length < 100) break;
  }
  return repos;
}

export async function getRepo(token: string, repoId: number): Promise<GithubRepo> {
  return toRepo(await githubFetch<ApiRepo>(token, `/repositories/${repoId}`));
}
