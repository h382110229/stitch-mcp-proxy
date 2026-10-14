/**
 * Stitch MCP Cloudflare Worker Reverse Proxy (Hardened Version)
 * 
 * Proxies Google Stitch MCP tool requests to https://stitch.googleapis.com
 * Features:
 * - Transparent X-Goog-Api-Key forwarding (Zero Key Storage)
 * - Optional Gateway Access Token (GATEWAY_TOKEN) anti-abuse shield
 * - Full Streaming & Server-Sent Events (SSE) support with duplex: 'half'
 * - Complete CORS preflight handling
 * - Defensive error handling & timeout guard
 */

export interface Env {
  /**
   * Optional secret token to protect your worker from unauthorized public abuse.
   * If set in Cloudflare Worker environment variables, clients must supply
   * either the 'X-Gateway-Token' header or '?gateway_token=...' in query string.
   * If unset or empty, requests are transparently forwarded without gateway auth.
   */
  GATEWAY_TOKEN?: string;
}

const UPSTREAM_ORIGIN = "https://stitch.googleapis.com";
const DEFAULT_REQUEST_TIMEOUT_MS = 60000; // 60s timeout for standard non-SSE requests

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH, HEAD",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const incomingUrl = new URL(request.url);

    // 1. Method Validation
    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response(
        JSON.stringify({
          error: {
            code: 405,
            status: "METHOD_NOT_ALLOWED",
            message: `Method ${request.method} is not allowed.`,
          },
        }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            ...CORS_HEADERS,
          },
        }
      );
    }

    // 2. Handle CORS Preflight (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // 3. Gateway Health Check & Info Route
    if (
      incomingUrl.pathname === "/health" ||
      (incomingUrl.pathname === "/" &&
        request.method === "GET" &&
        !request.headers.get("X-Goog-Api-Key") &&
        !incomingUrl.search)
    ) {
      return new Response(
        JSON.stringify(
          {
            service: "stitch-mcp-proxy",
            status: "ok",
            upstream: UPSTREAM_ORIGIN,
            endpoints: ["/mcp", "/*"],
            mode: "transparent-forwarding",
            auth_shield_enabled: Boolean(env.GATEWAY_TOKEN),
            timestamp: new Date().toISOString(),
          },
          null,
          2
        ),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            ...CORS_HEADERS,
          },
        }
      );
    }

    // 4. Gateway Anti-Abuse Token Verification (If configured)
    if (env.GATEWAY_TOKEN && env.GATEWAY_TOKEN.trim().length > 0) {
      const clientToken =
        request.headers.get("X-Gateway-Token") ||
        incomingUrl.searchParams.get("gateway_token");

      if (clientToken !== env.GATEWAY_TOKEN) {
        return new Response(
          JSON.stringify(
            {
              error: {
                code: 403,
                status: "FORBIDDEN",
                message: "Unauthorized gateway access. Missing or invalid X-Gateway-Token.",
              },
            },
            null,
            2
          ),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              ...CORS_HEADERS,
            },
          }
        );
      }
    }

    // 5. Construct Target Upstream URL (Preserves path and query parameters)
    const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, UPSTREAM_ORIGIN);

    // Clean internal gateway query token before forwarding upstream if present
    if (targetUrl.searchParams.has("gateway_token")) {
      targetUrl.searchParams.delete("gateway_token");
    }

    // 6. Clone and rewrite Request Headers
    const headers = new Headers(request.headers);
    headers.set("Host", "stitch.googleapis.com");

    // Remove Cloudflare internal edge headers and private gateway token
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");
    headers.delete("x-gateway-token");

    // 7. Timeout & Abort Control
    // For standard requests, enforce timeout; for SSE streams, skip short timeout
    const isSseClient = (request.headers.get("Accept") || "").includes("text/event-stream");
    const abortController = new AbortController();
    let timeoutId: any = null;

    if (!isSseClient) {
      timeoutId = setTimeout(() => {
        abortController.abort("Upstream request timed out");
      }, DEFAULT_REQUEST_TIMEOUT_MS);
    }

    // 8. Build Fetch Options with zero-buffering Streaming Body
    const fetchOptions: RequestInit = {
      method: request.method,
      headers,
      redirect: "follow",
      signal: abortController.signal,
    };

    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      fetchOptions.body = request.body;
      // @ts-expect-error duplex is a valid modern FetchInit property in Workers
      fetchOptions.duplex = "half";
    }

    try {
      // 9. Forward request to upstream Google Stitch API
      const upstreamResponse = await fetch(targetUrl.toString(), fetchOptions);

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // 10. Clone and adapt Response Headers
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Inject CORS headers
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        responseHeaders.set(key, value);
      }

      // Optimize for SSE (Server-Sent Events) and chunked streaming
      const contentType = responseHeaders.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        responseHeaders.set("Cache-Control", "no-cache, no-transform");
        responseHeaders.set("Connection", "keep-alive");
        responseHeaders.set("X-Accel-Buffering", "no");
      }

      // 11. Stream Response Body directly (zero buffering)
      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    } catch (error: unknown) {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      const isTimeout =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("timed out"));

      const statusCode = isTimeout ? 504 : 502;
      const statusText = isTimeout ? "GATEWAY_TIMEOUT" : "BAD_GATEWAY";
      const userMessage = isTimeout
        ? "Request to upstream Stitch API timed out after 60 seconds."
        : "Failed to establish connection with upstream Stitch API service.";

      return new Response(
        JSON.stringify(
          {
            error: {
              code: statusCode,
              status: statusText,
              message: userMessage,
              timestamp: new Date().toISOString(),
            },
          },
          null,
          2
        ),
        {
          status: statusCode,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            ...CORS_HEADERS,
          },
        }
      );
    }
  },
};
