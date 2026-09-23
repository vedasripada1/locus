import type { UserContext } from "../core/types";

const FIELDS: { key: keyof UserContext; label: string; placeholder: string; why: string }[] = [
  { key: "ageRange", label: "Age range", placeholder: "e.g. 40–49", why: "Flags age-dependent safety limits, such as supplement upper limits that differ for children." },
  { key: "ancestry", label: "Ancestry context", placeholder: "e.g. European, East Asian, mixed", why: "Flags associations whose lead study population differs from yours, because effect sizes may not transfer." },
  { key: "diagnoses", label: "Relevant diagnoses", placeholder: "e.g. type 2 diabetes, kidney stones", why: "A diagnosis always outranks genotype. Matching items are flagged for clinician discussion." },
  { key: "medications", label: "Medications", placeholder: "e.g. omeprazole, warfarin", why: "Used only to flag possible interactions. Never stop or change medication based on this report." },
  { key: "allergies", label: "Allergies", placeholder: "e.g. milk allergy", why: "Flags food-based options that may conflict." },
  { key: "dietaryRestrictions", label: "Dietary restrictions", placeholder: "e.g. vegan, halal, dairy-free", why: "Flags food-based options that may not fit your diet." },
  { key: "goals", label: "Goals", placeholder: "e.g. endurance performance, weight", why: "Lets you focus on sections. It never changes a finding." },
];

export function ContextForm({ value, onChange, notes }: { value: UserContext; onChange: (v: UserContext) => void; notes: string[] }) {
  return (
    <details className="panel no-print" style={{ marginTop: 18 }}>
      <summary>Optional: add context (every field is optional, stays in this tab, and is cleared by "Delete my data")</summary>
      <p className="muted" style={{ fontSize: ".92rem" }}>
        Context never turns a genotype into clinical advice. It only adds flags for discussion. What each field does is shown under it.
      </p>
      <div className="form-grid">
        {FIELDS.map((f) => (
          <label key={f.key} className="field">
            <b>{f.label}</b>
            <input type="text" value={value[f.key]} placeholder={f.placeholder} autoComplete="off" spellCheck={false}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })} />
            <small>{f.why}</small>
          </label>
        ))}
      </div>
      <ul className="limits">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </details>
  );
}
