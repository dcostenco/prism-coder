/**
 * Local search returned venue NAMES and nothing else: every address, phone,
 * rating and opening hour read "N/A". The name survived only because the
 * formatter happened to fall back to `title`.
 *
 * The cause is the same wrong-field defect found in the portal proxy: the
 * client read `name`, `address.streetAddress`, `phone`, `openingHours` and
 * `rating.ratingCount`, none of which Brave sends on a POI. The payload below
 * was captured from api.search.brave.com/res/v1/local/pois on 2026-09-16.
 */
import { describe, it, expect } from "vitest";
import { formatLocalResults } from "../src/utils/braveApi.js";

const REAL_POI = {
  id: "loc4TFGHARN5URBUBDMKJHE3YJSTYBI56TG46CAI7ZI=",
  title: "Miss Shirley's Cafe, Inner Harbor",
  postal_address: { type: "PostalAddress", displayAddress: "750 E Pratt St, Baltimore, MD 21202" },
  contact: { telephone: "+14105285373" },
  rating: { ratingValue: 4.4, bestRating: 5, reviewCount: 1361 },
  opening_hours: { current_day: [{ abbr_name: "Wed", opens: "08:00", closes: "15:00" }] },
  price_range: "$$",
} as never;

describe("a Brave POI renders every field it carries", () => {
  const out = formatLocalResults(
    { results: [REAL_POI] } as never,
    { descriptions: { "loc4TFGHARN5URBUBDMKJHE3YJSTYBI56TG46CAI7ZI=": "An award-winning cafe." } } as never,
  );

  it("renders the venue name from title", () => {
    expect(out).toContain("Name: Miss Shirley's Cafe, Inner Harbor");
  });

  it("renders the address from postal_address.displayAddress", () => {
    expect(out).toContain("Address: 750 E Pratt St, Baltimore, MD 21202");
  });

  it("renders the phone from contact.telephone", () => {
    expect(out).toContain("Phone: +14105285373");
  });

  it("renders the review count from rating.reviewCount", () => {
    expect(out).toContain("Rating: 4.4 (1361 reviews)");
  });

  it("renders today's hours from opening_hours.current_day", () => {
    expect(out).toContain("Hours: 08:00-15:00");
  });

  it("renders the price range from price_range", () => {
    expect(out).toContain("Price Range: $$");
  });

  it("leaves no field reading N/A on a fully populated venue", () => {
    // The whole symptom in one assertion: a real POI used to render six N/As.
    expect(out).not.toContain("N/A");
  });
});

describe("an older or sparser payload still parses", () => {
  it("falls back to the legacy shapes rather than crashing", () => {
    const legacy = {
      id: "x",
      name: "Legacy Diner",
      address: { streetAddress: "1 Main St", addressLocality: "Springfield" },
      phone: "555-1234",
      rating: { ratingValue: 4, ratingCount: 10 },
      openingHours: ["09:00-17:00"],
      priceRange: "$",
    } as never;
    const out = formatLocalResults({ results: [legacy] } as never, { descriptions: {} } as never);
    expect(out).toContain("Name: Legacy Diner");
    expect(out).toContain("Address: 1 Main St, Springfield");
    expect(out).toContain("Phone: 555-1234");
    expect(out).toContain("Rating: 4 (10 reviews)");
    expect(out).toContain("Hours: 09:00-17:00");
  });

  it("reports N/A for a venue that genuinely carries nothing", () => {
    const bare = { id: "y" } as never;
    const out = formatLocalResults({ results: [bare] } as never, { descriptions: {} } as never);
    expect(out).toContain("Name: N/A");
    expect(out).toContain("Address: N/A");
  });
});
