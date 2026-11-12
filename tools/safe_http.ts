import { lookup as dnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib"

export interface SafeHttpResponse {
  status: number
  statusText?: string
  headers: Headers
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
  url?: string
  cancel?: () => void
}

export type HostResolver = (hostname: string) => Promise<string[]>
export type SafeFetchMock = (url: string, init: RequestInit) => Promise<SafeHttpResponse>

interface ResolvedDestination {
  url: URL
  addresses: Array<{ address: string; family: 4 | 6 }>
}

function ipv4Value(address: string): number[] {
  return address.split(".").map(Number)
}

function ipv4In(address: string, network: number[], prefix: number): boolean {
  const value = ipv4Value(address)
  let remaining = prefix
  for (let i = 0; i < 4; i++) {
    const bits = Math.min(8, remaining)
    if (bits > 0 && (value[i] >> (8 - bits)) !== (network[i] >> (8 - bits))) return false
    remaining -= bits
  }
  return true
}

function ipv6Groups(raw: string): number[] | null {
  let value = raw.toLowerCase().split("%")[0]
  const mappedTail = value.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mappedTail) {
    const [a, b, c, d] = ipv4Value(mappedTail[1])
    value = value.slice(0, -mappedTail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = value.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  if (halves.length === 1 && left.length !== 8) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 2 && missing < 1) || missing < 0) return null
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16))
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff) ? groups : null
}

export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    return [
      [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10],
      [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
      [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24],
      [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
      [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
    ].some(([network, prefix]) => ipv4In(address, network as number[], prefix as number))
  }
  if (family === 6) {
    const groups = ipv6Groups(address)
    if (!groups) return true
    const mapped = groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff
    if (mapped) return isNonPublicAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`)
    const globalUnicast = (groups[0] & 0xe000) === 0x2000
    const reserved2001 = groups[0] === 0x2001 && groups[1] <= 0x01ff
    const documentation = (groups[0] === 0x2001 && groups[1] === 0x0db8) || (groups[0] === 0x3fff && groups[1] <= 0x0fff)
    const teredo = groups[0] === 0x2001 && groups[1] === 0
    const sixToFour = groups[0] === 0x2002
    return !globalUnicast || reserved2001 || documentation || teredo || sixToFour
  }
  return true
}

function isLocalHostname(host: string): boolean {
  return !host.includes(".") || [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".test", ".invalid", ".arpa"]
    .some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  const records = await dnsLookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

export async function resolveSafeDestination(raw: string | URL, resolveHost: HostResolver = defaultResolveHost): Promise<ResolvedDestination> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("invalid URL")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsupported URL scheme: ${url.protocol}`)
  const authority = typeof raw === "string" ? raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? "" : ""
  if (url.username || url.password || authority.includes("@")) throw new Error("URL credentials are not allowed")
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (isLocalHostname(host)) throw new Error("local/internal hostnames are not allowed")
  if (isIP(host) && isNonPublicAddress(host)) throw new Error("non-public IP destinations are not allowed")
  const resolved = await resolveHost(host)
  if (resolved.length === 0) throw new Error("hostname did not resolve")
  const addresses = resolved.map((address) => {
    const family = isIP(address)
    if (!family || isNonPublicAddress(address)) throw new Error("hostname resolves to a non-public address")
    return { address, family: family as 4 | 6 }
  })
  return { url, addresses }
}

export function safeRedirectUrl(from: string | URL, location: string): URL {
  const previous = new URL(from)
  const next = new URL(location, previous)
  if ((next.protocol !== "http:" && next.protocol !== "https:") || (previous.protocol === "https:" && next.protocol !== "https:")) {
    throw new Error("unsafe redirect protocol change")
  }
  if (next.username || next.password) throw new Error("URL credentials are not allowed")
  return next
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  const normalized = new Headers(headers)
  for (const name of ["host", "proxy-authorization", "proxy-connection"]) normalized.delete(name)
  return Object.fromEntries(normalized.entries())
}

export function pinnedLookup(addresses: ResolvedDestination["addresses"]) {
  const selected = addresses[0]
  return (_hostname: string, options: { all?: boolean }, callback: (...args: never[]) => void): void => {
    const done = callback as unknown as (...args: unknown[]) => void
    if (options?.all) done(null, addresses.map(({ address, family }) => ({ address, family })))
    else done(null, selected.address, selected.family)
  }
}

function decompress(response: NodeJS.ReadableStream, encoding: string | null): NodeJS.ReadableStream {
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "":
    case "identity": return response
    case "gzip":
    case "x-gzip": return response.pipe(createGunzip())
    case "deflate": return response.pipe(createInflate())
    case "br": return response.pipe(createBrotliDecompress())
    default: throw new Error("unsupported Content-Encoding")
  }
}

export function decodedBodyStream(response: Readable, encoding: string | null): ReadableStream<Uint8Array> {
  return Readable.toWeb(decompress(response, encoding) as Readable) as ReadableStream<Uint8Array>
}

export async function safeHttpRequest(
  raw: string | URL,
  init: RequestInit = {},
  resolveHost: HostResolver = defaultResolveHost,
): Promise<SafeHttpResponse> {
  const destination = await resolveSafeDestination(raw, resolveHost)
  return await requestResolved(destination, init)
}

async function requestResolved(destination: ResolvedDestination, init: RequestInit): Promise<SafeHttpResponse> {
  if (init.signal?.aborted) throw init.signal.reason ?? new Error("request aborted")
  const { url, addresses } = destination
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest
  return await new Promise((resolve, reject) => {
    const request = requestFn(url, {
      method: init.method ?? "GET",
      headers: headersRecord(init.headers),
      agent: false,
      signal: init.signal ?? undefined,
      servername: url.protocol === "https:" && !isIP(host) ? host : undefined,
      lookup: pinnedLookup(addresses),
    }, (response) => {
      let body: ReadableStream<Uint8Array>
      try {
        body = decodedBodyStream(response, response.headers["content-encoding"] ?? null)
      } catch (error) {
        response.destroy(error as Error)
        reject(error)
        return
      }
      resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage,
        headers: new Headers(Object.entries(response.headers).flatMap(([name, value]) =>
          value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((entry) => [name, entry] as [string, string]))),
        body,
        url: url.toString(),
        cancel: () => response.destroy(),
      })
    })
    request.on("error", reject)
    request.end()
  })
}

export async function safeFetch(
  raw: string | URL,
  init: RequestInit,
  resolveHost: HostResolver = defaultResolveHost,
  mockFetch?: SafeFetchMock,
): Promise<SafeHttpResponse> {
  const destination = await resolveSafeDestination(raw, resolveHost)
  const manualInit = { ...init, redirect: "manual" as RequestRedirect }
  if (mockFetch) return await mockFetch(destination.url.toString(), manualInit)
  return await requestResolved(destination, manualInit)
}

export async function readBoundedText(response: SafeHttpResponse, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid response byte limit")
  const declared = Number(response.headers.get("content-length"))
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase()
  if (Number.isFinite(declared) && declared > maxBytes && (!encoding || encoding === "identity")) {
    response.cancel?.()
    throw new Error(`response exceeds ${maxBytes} bytes`)
  }
  if (!response.body) {
    throw new Error("response body is unavailable")
  }
  const decoder = new TextDecoder("utf-8")
  let bytes = 0
  let output = ""
  const consume = (chunk: Uint8Array): void => {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`)
    output += decoder.decode(chunk, { stream: true })
  }
  try {
    if (Symbol.asyncIterator in Object(response.body)) {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) consume(chunk)
    } else {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          consume(value)
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined)
        throw error
      } finally {
        reader.releaseLock()
      }
    }
    output += decoder.decode()
    return output
  } catch (error) {
    response.cancel?.()
    throw error
  }
}
