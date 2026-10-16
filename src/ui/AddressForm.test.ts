import { describe, expect, it } from "vitest";
import { MAX_FLOOR, validateForm } from "./AddressForm";

// A floor that always passes, so address tests isolate the address check.
const OK_FLOOR = "12";
// An address that always passes, so floor tests isolate the floor check.
const OK_ADDRESS = "11 Wall St";

const NEED_ADDRESS = "Enter a NYC street address.";
const TOO_SHORT = "That address looks too short.";
const NEED_HOUSE_NUMBER = "Start with a house number, e.g. “11 Wall St”.";
const NEED_FLOOR = "Enter a floor number.";
const FLOOR_TOO_LOW = "Floor must be 1 or higher.";
const FLOOR_TOO_HIGH = `That's above any NYC building (max ${MAX_FLOOR}).`;

describe("validateForm: address", () => {
  it.each([
    ["11 Wall St"],
    ["350 5th Ave, Manhattan"],
    // Queens-style hyphenated house numbers.
    ["89-14 Parsons Blvd"],
    // Lettered house numbers, either case.
    ["12A Main St"],
    ["12a Main St"],
  ])("accepts %j", (address) => {
    expect(validateForm(address, OK_FLOOR)).toEqual({
      value: { address, floor: 12 },
    });
  });

  it("collapses and trims whitespace in the returned address", () => {
    expect(validateForm("  350   5th\tAve  ", OK_FLOOR).value?.address).toBe(
      "350 5th Ave",
    );
  });

  it.each([[""], ["   "], ["\t\n"]])("asks for an address when given %j", (address) => {
    expect(validateForm(address, OK_FLOOR)).toEqual({
      errors: { address: NEED_ADDRESS },
    });
  });

  it.each([["1 A"], ["  12  "]])("rejects %j as too short", (address) => {
    expect(validateForm(address, OK_FLOOR).errors?.address).toBe(TOO_SHORT);
  });

  it.each([
    // No house number at all.
    ["Wall St"],
    ["Times Square"],
    // A number with no street after it.
    ["1234"],
    // Street name before the number.
    ["Broadway 1585"],
    // More than one letter on the house number.
    ["12AB Main St"],
    // A dangling hyphen.
    ["89- Parsons Blvd"],
  ])("asks for a house number when given %j", (address) => {
    expect(validateForm(address, OK_FLOOR)).toEqual({
      errors: { address: NEED_HOUSE_NUMBER },
    });
  });
});

describe("validateForm: floor", () => {
  it("accepts floor 1 and MAX_FLOOR, the inclusive bounds", () => {
    expect(validateForm(OK_ADDRESS, "1").value?.floor).toBe(1);
    expect(validateForm(OK_ADDRESS, String(MAX_FLOOR)).value?.floor).toBe(
      MAX_FLOOR,
    );
  });

  it("trims whitespace around the floor", () => {
    expect(validateForm(OK_ADDRESS, "  85 ").value?.floor).toBe(85);
  });

  it.each([[""], ["   "], ["abc"], ["-"]])(
    "asks for a floor number when given %j",
    (floor) => {
      expect(validateForm(OK_ADDRESS, floor)).toEqual({
        errors: { floor: NEED_FLOOR },
      });
    },
  );

  it.each([["0"], ["-1"], ["-40"]])("rejects floor %j as too low", (floor) => {
    expect(validateForm(OK_ADDRESS, floor)).toEqual({
      errors: { floor: FLOOR_TOO_LOW },
    });
  });

  it.each([[String(MAX_FLOOR + 1)], ["131"], ["1000"]])(
    "rejects floor %j as above any NYC building",
    (floor) => {
      expect(validateForm(OK_ADDRESS, floor)).toEqual({
        errors: { floor: FLOOR_TOO_HIGH },
      });
    },
  );
});

describe("validateForm: both fields", () => {
  it("reports both errors at once and returns no value", () => {
    const result = validateForm("Wall St", "0");
    expect(result).toEqual({
      errors: { address: NEED_HOUSE_NUMBER, floor: FLOOR_TOO_LOW },
    });
    expect(result.value).toBeUndefined();
  });

  it("returns no errors key when the form is valid", () => {
    expect(validateForm(OK_ADDRESS, OK_FLOOR)).not.toHaveProperty("errors");
  });
});
