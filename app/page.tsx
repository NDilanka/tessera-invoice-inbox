"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import UploadZone from "@/components/UploadZone";
import ResultView from "@/components/ResultView";
import type { SampleDoc } from "@/lib/samples";
import { MAX_FILE_BYTES, ACCEPTED_MIME } from "@/lib/config";
import type { ExtractionResult } from "@/lib/schema";
import styles from "./page.module.css";

type Status = "idle" | "loading" | "done" | "error";

interface Loaded {
  result: ExtractionResult;
  previewUrl: string;
  media: string;
  key: number;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string>("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const objectUrl = useRef<string | null>(null);
  const runId = useRef(0);

  const revoke = () => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  };

  const run = useCallback(async (file: File, previewUrl: string, isObjectUrl: boolean) => {
    setStatus("loading");
    setError("");

    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch("/api/extract", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setStatus("error");
        setError(data?.message ?? "Extraction failed.");
        if (isObjectUrl) {
          URL.revokeObjectURL(previewUrl);
          if (objectUrl.current === previewUrl) objectUrl.current = null;
        }
        return;
      }
      runId.current += 1;
      setLoaded({
        result: data as ExtractionResult,
        previewUrl,
        media: file.type,
        key: runId.current,
      });
      setStatus("done");
    } catch {
      setStatus("error");
      setError("Couldn't reach the extraction service. Check your connection and retry.");
      if (isObjectUrl) {
        URL.revokeObjectURL(previewUrl);
        if (objectUrl.current === previewUrl) objectUrl.current = null;
      }
    }
  }, []);

  const onFile = useCallback(
    (file: File) => {
      // Cheap client-side guards for instant feedback; the API re-validates.
      if (!ACCEPTED_MIME.includes(file.type as (typeof ACCEPTED_MIME)[number])) {
        setStatus("error");
        setError("Only PDF, JPG, and PNG files are supported.");
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setStatus("error");
        setError(`That file is over ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB.`);
        return;
      }
      revoke();
      const url = URL.createObjectURL(file);
      objectUrl.current = url;
      run(file, url, true);
    },
    [run],
  );

  const onSample = useCallback(
    async (sample: SampleDoc) => {
      setStatus("loading");
      setError("");
      try {
        const res = await fetch(sample.path);
        const blob = await res.blob();
        const file = new File([blob], sample.path.split("/").pop() ?? "sample", {
          type: sample.media,
        });
        revoke(); // sample preview uses its public URL, no object URL to track
        run(file, sample.path, false);
      } catch {
        setStatus("error");
        setError("Couldn't load that sample. Try another.");
      }
    },
    [run],
  );

  const busy = status === "loading";

  // Reduced-transparency: make every glass surface opaque (see ios26 USAGE).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const apply = () =>
      document.documentElement.classList.toggle("reduce-transparency", mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  return (
    <main className={styles.page}>
      <div className={styles.navRow}>
        <div className={`nav-glass ${styles.nav}`}>
          <span className={styles.mark} aria-hidden="true">
            <Inbox size={20} strokeWidth={1.8} />
          </span>
          <span className={styles.wordmark}>Tessera</span>
        </div>
      </div>

      <header className={styles.header}>
        <h1 className={styles.title}>Invoice Inbox</h1>
        <p className={styles.tagline}>
          Drop an invoice or receipt → structured JSON with per-field confidence →
          review and export. Extraction runs on the native Anthropic API.
        </p>
      </header>

      <section className={styles.uploadSection}>
        <UploadZone onFile={onFile} onSample={onSample} disabled={busy} />
      </section>

      {busy && (
        <div className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          Reading the document…
        </div>
      )}

      {status === "error" && (
        <div className={styles.errorBanner} role="alert">
          {error}
        </div>
      )}

      {status === "done" && loaded && (
        <ResultView
          key={loaded.key}
          result={loaded.result}
          previewUrl={loaded.previewUrl}
          media={loaded.media}
        />
      )}

      <footer className={styles.footer}>
        <span>
          Fictional “Tessera” B2B SaaS demo · sample vendors are invented ·
          built with Claude Code.
        </span>
      </footer>
    </main>
  );
}
