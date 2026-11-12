import { expect, test } from "bun:test"
import { recordPostgrestResponse } from "../tools/postgrest_metrics"
import { SupabaseDiscoveryStore } from "../tools/generic_discovery"

test("discovery records UTF-8 response bytes without filters, secrets or content", async () => {
  const originalWrite = process.stderr.write
  const originalFetch = globalThis.fetch
  const output: string[] = []
  const body = JSON.stringify([{ id: 1, user_id: "private-user", name: "私密", is_active: true }])
  try {
    process.stderr.write = ((chunk: string | Uint8Array) => { output.push(String(chunk)); return true }) as typeof process.stderr.write
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch
    const store = new SupabaseDiscoveryStore("https://private.example", "secret-key")
    expect((await store.getActiveSearchProfile("private-user")).id).toBe(1)
    const metric = JSON.parse(output[0])
    expect(metric.response_body_bytes).toBe(Buffer.byteLength(body))
    expect(metric.endpoint).toBe("/rest/v1/search_profiles")
    expect(metric.operation).toBe("read")
    recordPostgrestResponse("PATCH", "/rest/v1/jobs?id=eq.private-user", 204, "")
    expect(JSON.parse(output[1]).response_body_bytes).toBe(0)
    for (const secret of ["private-user", "私密", "secret-key", "private.example"]) expect(output.join("")).not.toContain(secret)
  } finally {
    process.stderr.write = originalWrite
    globalThis.fetch = originalFetch
  }
})
