import { useRef, useState } from "react";

/**
 * Drafts for text fields saved on end editing and on exit. A draft lives until its field's saved
 * value changes, so a failed save is retried and a value replaced under it (even back to the same
 * text) drops it.
 */
export function useSettingsTextDrafts<Field extends string>(
  saved: Readonly<Record<Field, string | null>>,
) {
  const [seen, setSeen] = useState(saved);
  const [revisions, setRevisions] = useState<Partial<Record<Field, number>>>({});
  const fields = Object.keys(saved) as Field[];
  const changed = fields.filter((field) => seen[field] !== saved[field]);
  if (changed.length > 0) {
    setSeen(saved);
    setRevisions((current) => {
      const next = { ...current };
      for (const field of changed) next[field] = (next[field] ?? 0) + 1;
      return next;
    });
  }
  const drafts = useRef<Partial<Record<Field, { text: string; revision: number }>>>({});
  return {
    edit: (field: Field, text: string) => {
      drafts.current[field] = { text, revision: revisions[field] ?? 0 };
    },
    /** The trimmed text to save, if the draft is current and differs from the saved value. */
    unsaved: (field: Field): string | undefined => {
      const draft = drafts.current[field];
      if (draft === undefined) return undefined;
      const value = draft.text.trim();
      if (
        draft.revision === (revisions[field] ?? 0) &&
        (saved[field] === null || value !== saved[field])
      )
        return value;
      delete drafts.current[field];
      return undefined;
    },
  };
}
