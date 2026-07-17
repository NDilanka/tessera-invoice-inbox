"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { SAMPLES, type SampleDoc } from "@/lib/samples";
import { MAX_FILE_BYTES } from "@/lib/config";
import styles from "./UploadZone.module.css";

interface Props {
  onFile: (file: File) => void;
  onSample: (sample: SampleDoc) => void;
  disabled: boolean;
}

const ACCEPT = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";
const MB = Math.round(MAX_FILE_BYTES / (1024 * 1024));

/** Drag-and-drop / file-pick upload plus a one-click sample row. */
export default function UploadZone({ onFile, onSample, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onFile(file);
  }

  return (
    <div className={styles.wrap}>
      <div
        className={`${styles.drop} ${dragging ? styles.dragging : ""} ${
          disabled ? styles.disabled : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => !disabled && inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        aria-label="Upload an invoice or receipt"
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className={styles.hidden}
          onChange={(e) => handleFiles(e.target.files)}
          disabled={disabled}
        />
        <div className={styles.icon} aria-hidden="true">
          <Upload size={30} strokeWidth={1.8} />
        </div>
        <p className={styles.headline}>Drag an invoice or receipt here</p>
        <p className={styles.hint}>PDF, JPG, or PNG · up to {MB} MB · max 5 pages</p>
        <span className={`btn btn-filled ${styles.browseBtn}`} aria-hidden="true">
          Browse files
        </span>
      </div>

      <div className={styles.samples}>
        <span className={styles.samplesLabel}>No invoice handy? Try a sample:</span>
        <div className={styles.chips}>
          {SAMPLES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={styles.chip}
              disabled={disabled}
              onClick={() => onSample(s)}
              title={s.blurb}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
