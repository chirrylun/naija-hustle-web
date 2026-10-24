import type { NextRequest } from "next/server";

// Server-side proxy for the Naija Radio API. The API key stays in the server
// environment and never reaches the browser. Audio itself is NOT relayed: the
// browser connects straight to each broadcaster's `streamUrl`.

const FORWARDED_HEADERS = [
  "Retry-After",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-RateLimit-Reset",
];

export async function GET(request: NextRequest) {
  const key = process.env.NAIJA_RADIO_API_KEY;
  const base = process.env.NAIJA_RADIO_API_BASE_URL;

  if (!key || !base) {
    return Response.json(
      { error: "Radio integration is not configured" },
      { status: 503 },
    );
  }

  // Only a validated numeric offset is passed through (for paging the
  // catalogue via `pagination.nextOffset`). Nothing else from the client is
  // forwarded.
  const offsetParam = request.nextUrl.searchParams.get("offset");
  const offset = offsetParam !== null ? Number(offsetParam) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return Response.json({ error: "Invalid offset" }, { status: 400 });
  }

  const upstream = new URL(`${base.replace(/\/$/, "")}/stations`);
  upstream.searchParams.set("countryCode", "NG");
  upstream.searchParams.set("limit", "100");
  if (offset > 0) upstream.searchParams.set("offset", String(offset));

  try {
    const response = await fetch(upstream, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });

    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    });
    for (const name of FORWARDED_HEADERS) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(await response.text(), {
      status: response.status,
      headers,
    });
  } catch {
    return Response.json(
      { error: "Radio service is temporarily unavailable" },
      { status: 503 },
    );
  }
}
