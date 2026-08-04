import { useState, type FormEvent } from "react";
import { validateAddress, validateFloor } from "../lib/validation";

export interface AddressFormValue {
  address: string;
  floor: number;
}

interface AddressFormProps {
  onSubmit: (value: AddressFormValue) => void;
  busy: boolean;
}

/**
 * The address + floor input. Client-side validation gives immediate feedback
 * (house-number shape, floor range); the authoritative NYC check happens
 * downstream against the NYC-only GeoSearch service.
 */
export function AddressForm({ onSubmit, busy }: AddressFormProps) {
  const [address, setAddress] = useState("");
  const [floor, setFloor] = useState("27");
  const [addressError, setAddressError] = useState<string>();
  const [floorError, setFloorError] = useState<string>();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const a = validateAddress(address);
    const f = validateFloor(floor);
    setAddressError(a.valid ? undefined : a.error);
    setFloorError(f.valid ? undefined : f.error);
    if (a.valid && f.valid) {
      onSubmit({ address: a.normalized, floor: f.floor });
    }
  }

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label className="field__label" htmlFor="addr">
          NYC address
        </label>
        <input
          id="addr"
          className="field__input field__input--mono"
          type="text"
          inputMode="text"
          autoComplete="street-address"
          placeholder="11 Wall St"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          aria-invalid={addressError ? true : undefined}
          aria-describedby="addr-err"
          disabled={busy}
        />
        <span className="field__error" id="addr-err">
          {addressError}
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="floor">
          Floor
        </label>
        <input
          id="floor"
          className="field__input"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="27"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
          aria-invalid={floorError ? true : undefined}
          aria-describedby="floor-err"
          disabled={busy}
        />
        <span className="field__error" id="floor-err">
          {floorError}
        </span>
      </div>

      <div className="field">
        {/* Spacer label keeps the button baseline-aligned with the inputs. */}
        <span className="field__label" aria-hidden="true">
          &nbsp;
        </span>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Resolving…" : "View from here"}
        </button>
        <span className="field__error" aria-hidden="true">
          &nbsp;
        </span>
      </div>
    </form>
  );
}
