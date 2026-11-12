/** Decoded response body sizes, not compressed wire bytes or billing totals. */
export function recordPostgrestResponse(method: string, path: string, status: number, body: string): void {
  let endpoint = path.split("?", 1)[0]
  if (!endpoint.startsWith("/rest/v1/")) return
  if (!/^\/rest\/v1\/(?:rpc\/)?[a-z_][a-z0-9_]{0,62}$/.test(endpoint)) endpoint = "/rest/v1/other"
  method = ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ? method.toUpperCase() : "OTHER"
  const operation = endpoint.includes("/rpc/") ? "rpc" : ({ GET: "read", POST: "insert", PATCH: "update", DELETE: "delete" } as Record<string, string>)[method] ?? "other"
  process.stderr.write(JSON.stringify({
    event: "postgrest_response", runtime: "discovery", timestamp: new Date().toISOString(),
    endpoint, method, operation, status, requests: 1,
    response_body_bytes: Buffer.byteLength(body, "utf8"),
  }) + "\n")
}
