const TOKEN_KEY = "harmonia-operator-token";

export function getOperatorToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setOperatorToken(token: string): void {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = getOperatorToken();
  if (token) headers.set("x-operator-token", token);
  return fetch(path, { ...init, headers, cache: "no-store" });
}
