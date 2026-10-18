import { describe, expect, it, vi } from "vitest";
import {
  clampBoundingBox,
  redfinViewportUrl,
  resolveRedfinSearchUrl,
  zipFromQuery,
} from "../lib/deals/redfinUrl";

// tri_angle/redfin-search consumes Redfin MAP search URLs only. These
// tests pin the exact URL shapes the Actor is sent: /zipcode/{zip} for
// ZIP queries and /zipcode/{postcode}/filter/viewport=N:S:E:W,no-outline
// for geocoded city queries (a bare /filter/viewport= URL returns ZERO
// items — verified live 2026-10-18; Redfin's viewport order is
// latN:latS:lngE:lngW).

function stubFetch(impl: (url: string, init?: unknown) => Promise<unknown>) {
  return vi.fn(impl) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
}

describe("zipFromQuery", () => {
  it("accepts a bare 5-digit ZIP", () => {
    expect(zipFromQuery("46225")).toBe("46225");
  });

  it("uses the first 5 digits of a ZIP+4", () => {
    expect(zipFromQuery("46225-1234")).toBe("46225");
  });

  it("trims surrounding whitespace", () => {
    expect(zipFromQuery("  46225 \n")).toBe("46225");
    expect(zipFromQuery(" 46225-1234 ")).toBe("46225");
  });

  it("rejects non-ZIP queries", () => {
    expect(zipFromQuery("Indianapolis, IN")).toBeNull();
    expect(zipFromQuery("4622")).toBeNull();
    expect(zipFromQuery("462255")).toBeNull();
    expect(zipFromQuery("46225-123")).toBeNull();
    expect(zipFromQuery("")).toBeNull();
    expect(zipFromQuery("   ")).toBeNull();
  });
});

describe("redfinViewportUrl", () => {
  it("anchors the viewport on the zipcode path, formatted N:S:E:W with no-outline", () => {
    expect(
      redfinViewportUrl("46204", {
        north: "1",
        south: "2",
        east: "3",
        west: "4",
      }),
    ).toBe(
      "https://www.redfin.com/zipcode/46204/filter/viewport=1:2:3:4,no-outline",
    );
  });
});

describe("clampBoundingBox", () => {
  it("passes a small box through (reformatted) unchanged in extent", () => {
    expect(
      clampBoundingBox({
        south: "39.63227",
        north: "39.92736",
        west: "-86.32486",
        east: "-85.93517",
      }),
    ).toEqual({
      south: "39.63227",
      north: "39.92736",
      west: "-86.32486",
      east: "-85.93517",
    });
  });

  it("clamps an oversized box to 0.30 lat x 0.40 lng around its center", () => {
    // Span 2.0 lat x 3.0 lng, center (39, -86.5).
    expect(
      clampBoundingBox({
        south: "38",
        north: "40",
        west: "-88",
        east: "-85",
      }),
    ).toEqual({ south: "38.85", north: "39.15", west: "-86.7", east: "-86.3" });
  });

  it("clamps each axis independently", () => {
    // Lat span 0.10 (inside cap) untouched; lng span 1.0 clamped to 0.40
    // around center lng -86.
    expect(
      clampBoundingBox({
        south: "39.7",
        north: "39.8",
        west: "-86.5",
        east: "-85.5",
      }),
    ).toEqual({
      south: "39.7",
      north: "39.8",
      west: "-86.2",
      east: "-85.8",
    });
  });
});

describe("resolveRedfinSearchUrl", () => {
  it("maps a ZIP query to the zipcode URL without geocoding", async () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error("must not fetch for a ZIP query");
    });
    await expect(resolveRedfinSearchUrl("46225", fetchImpl)).resolves.toBe(
      "https://www.redfin.com/zipcode/46225",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps a whitespace-padded ZIP+4 to the 5-digit zipcode URL", async () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error("must not fetch for a ZIP query");
    });
    await expect(
      resolveRedfinSearchUrl("  46225-1234 ", fetchImpl),
    ).resolves.toBe("https://www.redfin.com/zipcode/46225");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("geocodes a city query into the zipcode-anchored viewport URL (N:S:E:W)", async () => {
    // Nominatim boundingbox order: [south, north, west, east]. The
    // Indianapolis box spans 0.295 lat x 0.390 lng — inside the clamps,
    // so it passes through; the centroid postcode 46204 (from
    // addressdetails=1) anchors the path.
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [
        {
          boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"],
          address: { postcode: "46204" },
        },
      ],
    }));
    const url = await resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/46204/filter/viewport=39.92736:39.63227:-85.93517:-86.32486,no-outline",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [reqUrl, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { headers: Record<string, string> }];
    expect(reqUrl).toContain("https://nominatim.openstreetmap.org/search?");
    expect(reqUrl).toContain("format=jsonv2");
    expect(reqUrl).toContain("limit=1");
    expect(reqUrl).toContain("addressdetails=1");
    expect(reqUrl).toContain("q=Indianapolis%2C%20IN");
    expect(init.headers["User-Agent"]).toContain("WholesaleAI");
  });

  it("clamps an oversized geocoded box around its center", async () => {
    // County-sized box: span 2.0 lat x 3.0 lng, center (39, -86.5).
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [
        {
          boundingbox: ["38", "40", "-88", "-85"],
          address: { postcode: "46204" },
        },
      ],
    }));
    const url = await resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/46204/filter/viewport=39.15:38.85:-86.3:-86.7,no-outline",
    );
  });

  it("falls back to the plain zipcode URL when a postcode resolves without a bounding box", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [{ address: { postcode: "46204" } }],
    }));
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).resolves.toBe("https://www.redfin.com/zipcode/46204");
  });

  it("throws a try-a-ZIP error when the geocoded place has no postcode", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [
        { boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"] },
      ],
    }));
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/ZIP code/);
  });

  it("reverse-geocodes the bbox center when a city-level forward result has no postcode", async () => {
    // The real shape of a city-level Nominatim forward result: its
    // address carries city/state/country but NO postcode. The reverse
    // lookup of the bounding-box center (39.779815, -86.130015)
    // returns the centroid postcode 46204, which anchors the URL.
    const fetchImpl = stubFetch(async (url: string) => {
      if (url.includes("/reverse")) {
        return {
          ok: true,
          json: async () => ({ address: { postcode: "46204" } }),
        };
      }
      return {
        ok: true,
        json: async () => [
          {
            boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"],
            address: {
              city: "Indianapolis",
              state: "Indiana",
              country: "United States",
            },
          },
        ],
      };
    });
    const url = await resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/46204/filter/viewport=39.92736:39.63227:-85.93517:-86.32486,no-outline",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [reverseUrl, reverseInit] = (fetchImpl as ReturnType<typeof vi.fn>)
      .mock.calls[1] as [string, { headers: Record<string, string> }];
    expect(reverseUrl).toContain(
      "https://nominatim.openstreetmap.org/reverse?",
    );
    expect(reverseUrl).toContain("format=jsonv2");
    expect(reverseUrl).toContain("lat=39.779815");
    expect(reverseUrl).toContain("lon=-86.130015");
    expect(reverseInit.headers["User-Agent"]).toContain("WholesaleAI");
  });

  it("tries the anchor point before the bbox center and uses the first postcode found (Savannah shape)", async () => {
    // Savannah, GA (the live failure): the forward result is a
    // boundary relation — bbox [31.8878520, 32.1896620, -81.3714270,
    // -81.0295150] plus its own anchor lat/lon, address WITHOUT a
    // postcode. Reverse-geocoding the anchor lands on a road address
    // (no postcode); the bbox center (32.038757, -81.200471) yields
    // 31401. The lat span 0.30181 exceeds the 0.30 cap, so the
    // viewport is clamped around the center; the lng span passes.
    const calls: string[] = [];
    const fetchImpl = stubFetch(async (url: string) => {
      calls.push(url);
      if (url.includes("/reverse")) {
        if (url.includes("lat=32.080899")) {
          return {
            ok: true,
            json: async () => ({
              address: { road: "Ogeechee Road", city: "Savannah" },
            }),
          };
        }
        if (url.includes("lat=32.038757")) {
          return {
            ok: true,
            json: async () => ({ address: { postcode: "31401" } }),
          };
        }
        return { ok: true, json: async () => ({ address: {} }) };
      }
      return {
        ok: true,
        json: async () => [
          {
            lat: "32.080899",
            lon: "-81.091204",
            boundingbox: ["31.8878520", "32.1896620", "-81.3714270", "-81.0295150"],
            address: {
              city: "Savannah",
              state: "Georgia",
              country: "United States",
            },
          },
        ],
      };
    });
    const url = await resolveRedfinSearchUrl("Savannah, GA", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/31401/filter/viewport=32.188757:31.888757:-81.029515:-81.371427,no-outline",
    );
    // Attempt order: forward, anchor reverse, center reverse — stop.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("lat=32.080899");
    expect(calls[1]).toContain("lon=-81.091204");
    expect(calls[2]).toContain("lat=32.038757");
    expect(calls[2]).toContain("lon=-81.200471");
  });

  it("stops after the first reverse point when it already yields a postcode", async () => {
    const fetchImpl = stubFetch(async (url: string) => {
      if (url.includes("/reverse")) {
        return {
          ok: true,
          json: async () => ({ address: { postcode: "46204" } }),
        };
      }
      return {
        ok: true,
        json: async () => [
          {
            lat: "39.768403",
            lon: "-86.158068",
            boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"],
            address: { city: "Indianapolis", state: "Indiana" },
          },
        ],
      };
    });
    const url = await resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/46204/filter/viewport=39.92736:39.63227:-85.93517:-86.32486,no-outline",
    );
    // Forward + exactly ONE reverse (the anchor); no center/quadrant
    // attempts are made once a postcode is in hand.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws a try-a-ZIP error after trying every candidate point without a postcode", async () => {
    const fetchImpl = stubFetch(async (url: string) => {
      if (url.includes("/reverse")) {
        return {
          ok: true,
          json: async () => ({
            address: { road: "Ogeechee Road", city: "Savannah" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => [
          {
            lat: "32.080899",
            lon: "-81.091204",
            boundingbox: ["31.8878520", "32.1896620", "-81.3714270", "-81.0295150"],
            address: { city: "Savannah", state: "Georgia" },
          },
        ],
      };
    });
    await expect(
      resolveRedfinSearchUrl("Savannah, GA", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
    await expect(
      resolveRedfinSearchUrl("Savannah, GA", fetchImpl),
    ).rejects.toThrow(/ZIP code/);
    // Per attempt: 1 forward + at most 6 reverse calls (anchor,
    // center, four quadrant centers).
    expect(fetchImpl).toHaveBeenCalledTimes(14);
  });

  it("throws a try-a-ZIP error when forward and reverse both lack a postcode", async () => {
    const fetchImpl = stubFetch(async (url: string) => {
      if (url.includes("/reverse")) {
        return {
          ok: true,
          json: async () => ({
            address: { city: "Indianapolis", state: "Indiana" },
          }),
        };
      }
      return {
        ok: true,
        json: async () => [
          {
            boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"],
            address: { city: "Indianapolis", state: "Indiana" },
          },
        ],
      };
    });
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/ZIP code/);
  });

  it("throws a try-a-ZIP error when the reverse geocode request fails", async () => {
    const fetchImpl = stubFetch(async (url: string) => {
      if (url.includes("/reverse")) throw new Error("network down");
      return {
        ok: true,
        json: async () => [
          {
            boundingbox: ["39.63227", "39.92736", "-86.32486", "-85.93517"],
            address: { city: "Indianapolis", state: "Indiana" },
          },
        ],
      };
    });
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
  });

  it("does not reverse-geocode when the forward result has neither postcode nor bounding box", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [{ address: { city: "Nowhere" } }],
    }));
    await expect(
      resolveRedfinSearchUrl("Nowhere", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace around a city query before geocoding", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [
        {
          boundingbox: ["28.50029", "28.61051", "-81.41155", "-81.21071"],
          address: { postcode: "32754" },
        },
      ],
    }));
    const url = await resolveRedfinSearchUrl("  Mims, FL  ", fetchImpl);
    expect(url).toBe(
      "https://www.redfin.com/zipcode/32754/filter/viewport=28.61051:28.50029:-81.21071:-81.41155,no-outline",
    );
  });

  it("throws a try-a-ZIP error when the geocoder finds nothing", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: true,
      json: async () => [],
    }));
    await expect(
      resolveRedfinSearchUrl("Nowheresville", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
    await expect(
      resolveRedfinSearchUrl("Nowheresville", fetchImpl),
    ).rejects.toThrow(/ZIP code/);
  });

  it("throws the same error when the geocoder request fails", async () => {
    const fetchImpl = stubFetch(async () => {
      throw new Error("network down");
    });
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
  });

  it("throws the same error on a non-OK geocoder response", async () => {
    const fetchImpl = stubFetch(async () => ({
      ok: false,
      json: async () => ({}),
    }));
    await expect(
      resolveRedfinSearchUrl("Indianapolis, IN", fetchImpl),
    ).rejects.toThrow(/could not resolve/i);
  });
});
