import type { FieldMeta } from "@/lib/schema";
import styles from "./ConfidenceBadge.module.css";

const LABEL: Record<FieldMeta["status"], string> = {
  green: "OK",
  amber: "Check",
  red: "Review",
};

const FLAG_LABEL: Record<string, string> = {
  arithmetic_mismatch: "doesn't add up",
  format_warning: "unrecognized date",
};

/** A small green/amber/red pill summarizing a field's review status. */
export default function ConfidenceBadge({ meta }: { meta: FieldMeta }) {
  const title =
    `model confidence: ${meta.confidence}` +
    (meta.flags.length
      ? ` · ${meta.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}`
      : "");
  return (
    <span
      className={`${styles.badge} ${styles[meta.status]}`}
      title={title}
      aria-label={`Status ${LABEL[meta.status]}. ${title}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      {LABEL[meta.status]}
    </span>
  );
}
