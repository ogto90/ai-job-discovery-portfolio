import { describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"
import { Readable } from "node:stream"
import { decodedBodyStream, isNonPublicAddress, pinnedLookup, readBoundedText, resolveSafeDestination, safeFetch, safeHttpRequest, safeRedirectUrl } from "../tools/safe_http"

const publicResolver = async () => ["93.184.216.34"]

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

function response(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return { status: 200, headers: new Headers(headers), body }
}

describe("safe HTTP destination validation", () => {
  test("permits public HTTPS and canonicalizes alternative IPv4 forms before validation", async () => {
    const allowed = await resolveSafeDestination("https://example.com/job", publicResolver)
    expect(allowed.url.hostname).toBe("example.com")
    expect(allowed.addresses).toEqual([{ address: "93.184.216.34", family: 4 }])
    await expect(resolveSafeDestination("http://2130706433/", publicResolver)).rejects.toThrow()
    await expect(resolveSafeDestination("http://0x7f000001/", publicResolver)).rejects.toThrow()
  })

  test("rejects private, special-use, mapped, and transition addresses", () => {
    for (const address of [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254",
      "172.16.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "203.0.113.1", "224.0.0.1",
      "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:2::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a00:1",
    ]) expect(isNonPublicAddress(address)).toBe(true)
    expect(isNonPublicAddress("93.184.216.34")).toBe(false)
    expect(isNonPublicAddress("2606:4700:4700::1111")).toBe(false)
  })

  test("rejects URL credentials, non-HTTP schemes, local hostnames, mixed and private DNS answers", async () => {
    await expect(resolveSafeDestination("https://user:pass@example.com", publicResolver)).rejects.toThrow("credentials")
    await expect(resolveSafeDestination("https://@example.com", publicResolver)).rejects.toThrow("credentials")
    await expect(resolveSafeDestination("file:///etc/passwd", publicResolver)).rejects.toThrow("scheme")
    for (const hostname of ["localhost", "printer.local", "db.internal", "service.lan", "metadata.google.internal"]) {
      await expect(resolveSafeDestination(`https://${hostname}/`, publicResolver)).rejects.toThrow()
    }
    await expect(resolveSafeDestination("https://example.com", async () => ["93.184.216.34", "10.0.0.4"])).rejects.toThrow("non-public")
    await expect(resolveSafeDestination("https://example.com", async () => [])).rejects.toThrow("did not resolve")
    await expect(resolveSafeDestination("https://example.com", async () => { throw new Error("DNS unavailable") })).rejects.toThrow("DNS unavailable")
  })

  test("pins the connection lookup to validated answers instead of performing another DNS lookup", async () => {
    const destination = await resolveSafeDestination("https://example.com", async () => ["93.184.216.34", "2606:4700:4700::1111"])
    let call: unknown[] = []
    const lookup = pinnedLookup(destination.addresses)
    lookup("example.com", {}, ((...args: unknown[]) => { call = args }) as never)
    expect(call.slice(1)).toEqual(["93.184.216.34", 4])
    lookup("example.com", { all: true }, ((...args: unknown[]) => { call = args }) as never)
    expect(call[1]).toEqual(destination.addresses)
  })

  test("validates once per request and sends redirects through a fresh validation", async () => {
    let dnsCalls = 0
    let requested = ""
    const resolver = async () => { dnsCalls += 1; return ["93.184.216.34"] }
    await safeFetch("https://example.com/start", { redirect: "follow" }, resolver, async (url) => {
      requested = url
      return { status: 302, headers: new Headers({ location: "http://127.0.0.1/private" }), body: stream([]) }
    })
    expect(requested).toBe("https://example.com/start")
    expect(dnsCalls).toBe(1)
    await expect(safeFetch("http://127.0.0.1/private", {}, resolver, async () => ({ status: 200, headers: new Headers(), body: stream([]) }))).rejects.toThrow()
    expect(safeRedirectUrl("https://example.com/start", "/next").toString()).toBe("https://example.com/next")
    expect(() => safeRedirectUrl("https://example.com/start", "http://example.com/next")).toThrow("protocol")
    expect(() => safeRedirectUrl("https://example.com/start", "file:///etc/passwd")).toThrow("protocol")
  })

  test("an aborted request fails before opening a connection", async () => {
    const controller = new AbortController()
    controller.abort(new Error("connection timeout"))
    await expect(safeHttpRequest("https://example.com", { signal: controller.signal }, publicResolver)).rejects.toThrow("connection timeout")
  })
})

describe("bounded response decoding", () => {
  test("accepts empty, under-limit, and exact-limit response bodies", async () => {
    expect(await readBoundedText(response(stream([])), 4)).toBe("")
    expect(await readBoundedText(response(stream([new TextEncoder().encode("abc")])), 4)).toBe("abc")
    expect(await readBoundedText(response(stream([new TextEncoder().encode("abcd")])), 4)).toBe("abcd")
  })

  test("enforces the limit over many chunks and cancels an oversized single chunk", async () => {
    let cancelled = false
    const oversized = {
      ...response(stream([new TextEncoder().encode("12345")])),
      cancel: () => { cancelled = true },
    }
    await expect(readBoundedText(response(stream([new TextEncoder().encode("12"), new TextEncoder().encode("345")])), 4)).rejects.toThrow("exceeds 4 bytes")
    await expect(readBoundedText(oversized, 4)).rejects.toThrow("exceeds 4 bytes")
    expect(cancelled).toBe(true)
  })

  test("decodes UTF-8 across chunk boundaries and rejects declared oversize bodies early", async () => {
    const bytes = new TextEncoder().encode("A€B")
    const result = await readBoundedText(response(stream([bytes.slice(0, 2), bytes.slice(2, 3), bytes.slice(3)])), 5)
    expect(result).toBe("A€B")
    let cancelled = false
    await expect(readBoundedText({ ...response(stream([]), { "content-length": "5" }), cancel: () => { cancelled = true } }, 4)).rejects.toThrow()
    expect(cancelled).toBe(true)
  })

  test("does not trust missing or incorrect Content-Length over streamed byte counts", async () => {
    await expect(readBoundedText(response(stream([new TextEncoder().encode("large")]), { "content-length": "1" }), 4)).rejects.toThrow()
    expect(await readBoundedText(response(stream([new TextEncoder().encode("ok")]), { "content-length": "1" }), 4)).toBe("ok")
  })

  test("propagates stream failures and abort errors", async () => {
    const failed = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("stream broke")) } })
    await expect(readBoundedText(response(failed), 20)).rejects.toThrow("stream broke")
    const aborted = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new DOMException("The operation was aborted", "AbortError")) } })
    await expect(readBoundedText(response(aborted), 20)).rejects.toThrow("aborted")
  })

  test("decompresses gzip before enforcing the byte limit", async () => {
    const compressed = gzipSync("decompressed payload")
    const decoded = decodedBodyStream(Readable.from([compressed]), "gzip")
    await expect(readBoundedText(response(decoded, { "content-encoding": "gzip", "content-length": String(compressed.byteLength) }), 10)).rejects.toThrow("exceeds 10 bytes")
    const decodedSmall = decodedBodyStream(Readable.from([gzipSync("small")]), "gzip")
    expect(await readBoundedText(response(decodedSmall, { "content-encoding": "gzip" }), 10)).toBe("small")
  })
})
