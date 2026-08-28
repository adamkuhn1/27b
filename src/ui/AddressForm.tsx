// Address + floor input, and the curated-building picker.
//
// The picker is the primary way in: 27B only renders buildings on the curated
// list (see lib/curated.ts for why), so the supported set is presented up
// front as the offer — not discovered by trial and error. Free-text entry
// stays, because "type any address and get an honest answer" is part of the
// product: an unsupported address gets a clear not-yet state, never a broken
// render.

import { useState, type FormEvent } from "react";
import { CURATED_BUILDINGS } from "../lib/curated";

export interface AddressFormValue {
  address: string;
  floor: number;
}

/** Max floor accepted by the form; taller than any NYC building. */
export const MAX_FLOOR = 130;

export interface AddressValidationError {
  address?: string;
  floor?: string;
}

/**
 * Validate the free-text form. Requires a leading house number ("11 Wall St")
 * because GeoSearch resolves poorly on bare neighborhood names and the app is
 * address-level. Queens-style hyphenated numbers ("89-14 Parsons Blvd") and
 * lettered numbers ("12A") are allowed.
 */
export function validateForm(
  address: string,
  floorRaw: string,
): { value?: AddressFormValue; errors?: AddressValidationError } {
  const errors: AddressValidationError = {};
  const normalized = address.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    errors.address = "Enter a NYC street address.";
  } else if (normalized.length < 4) {
    errors.address = "That address looks too short.";
  } else if (!/^\d+(?:[-/]\d+)?[a-z]?\s+\S+/i.test(normalized)) {
    errors.address = "Start with a house number, e.g. “11 Wall St”.";
  }

  const floor = Number.parseInt(floorRaw.trim(), 10);
  if (!Number.isFinite(floor) || Number.isNaN(floor)) {
    errors.floor = "Enter a floor number.";
  } else if (!Number.isInteger(floor) || floor < 1) {
    errors.floor = "Floor must be 1 or higher.";
  } else if (floor > MAX_FLOOR) {
    errors.floor = `That's above any NYC building (max ${MAX_FLOOR}).`;
  }

  if (errors.address || errors.floor) return { errors };
  return { value: { address: normalized, floor } };
}

interface Props {
  disabled: boolean;
  onSubmit: (value: AddressFormValue) => void;
}

export function AddressForm({ disabled, onSubmit }: Props) {
  const [address, setAddress] = useState("");
  const [floor, setFloor] = useState("");
  const [errors, setErrors] = useState<AddressValidationError>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const check = validateForm(address, floor);
    setErrors(check.errors ?? {});
    if (check.value) onSubmit(check.value);
  };

  const pick = (addr: string, suggestedFloor: number) => {
    setAddress(addr);
    setFloor(String(suggestedFloor));
    setErrors({});
    onSubmit({ address: addr, floor: suggestedFloor });
  };

  return (
    <div className="address-form">
      <form onSubmit={submit} className="entry" aria-label="Address lookup">
        <div className="entry-row">
          <label className="field">
            <span>NYC street address</span>
            <input
              type="text"
              value={address}
              placeholder="350 5th Ave, Manhattan"
              disabled={disabled}
              onChange={(e) => setAddress(e.target.value)}
              aria-invalid={Boolean(errors.address)}
            />
            {errors.address && <em className="field-error">{errors.address}</em>}
          </label>
          <label className="field field-floor">
            <span>Floor</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_FLOOR}
              value={floor}
              placeholder="12"
              disabled={disabled}
              onChange={(e) => setFloor(e.target.value)}
              aria-invalid={Boolean(errors.floor)}
            />
            {errors.floor && <em className="field-error">{errors.floor}</em>}
          </label>
          <button type="submit" className="lookup" disabled={disabled}>
            View
          </button>
        </div>
      </form>

      <section className="picker" aria-label="Buildings with verified views">
        <h2 className="section-label">Supported buildings</h2>
        <p className="picker-note">
          27B only renders buildings it has checked ahead of time. Other
          addresses will get an honest "not supported yet" message.
        </p>
        <ul className="picker-list">
          {CURATED_BUILDINGS.map((b) => (
            <li key={b.bin}>
              <button
                type="button"
                className="picker-chip"
                disabled={disabled}
                onClick={() => pick(b.address, b.suggestedFloor)}
              >
                <span className="chip-name">{b.name}</span>
                <span className="chip-floors">
                  floors {b.floors.min}-{b.floors.max}
                </span>
                <span className="chip-note">{b.note}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
