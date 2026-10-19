// P1 regression: partner ingest must follow redirects MANUALLY and re-check
// every hop against the host policy, so an allowed URL can't 302 the server
// into an internal/metadata address (SSRF). We stub global fetch to drive the
// redirect chain without touching the network.

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchUrlText } from "../lib/partner-ingest";

type FetchFn = typeof fetch;
const realFetch: FetchFn = globalThis.fetch;

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
function okResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchUrlText redirect hardening", () => {
  it("blocks a redirect that points at an internal/metadata host", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls += 1;
      const u = String(input instanceof Request ? input.url : input);
      if (u.startsWith("https://partner.example.com")) {
        // Allowed first hop redirects to the cloud metadata endpoint.
        return redirectResponse("http://169.254.169.254/latest/meta-data/");
      }
      throw new Error(`fetch should not have followed to ${u}`);
    }) as FetchFn;

    await assert.rejects(
      () => fetchUrlText("https://partner.example.com/profile"),
      /redirect host is not allowed/,
    );
    assert.equal(calls, 1, "must not fetch the blocked redirect target");
  });

  it("follows an allowed redirect chain and returns the final text", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u === "https://partner.example.com/old") {
        return redirectResponse("https://partner.example.com/new");
      }
      return okResponse("<html><body>Hello <b>Partner</b></body></html>");
    }) as FetchFn;

    const text = await fetchUrlText("https://partner.example.com/old");
    assert.match(text, /Hello\s+Partner/);
  });

  it("rejects an outright blocked initial host before any fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return okResponse("nope");
    }) as FetchFn;

    await assert.rejects(() => fetchUrlText("http://169.254.169.254/"), /not allowed/);
    assert.equal(calls, 0, "blocked host must never be fetched");
  });
});
