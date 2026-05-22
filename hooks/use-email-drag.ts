"use client";

import { useCallback, useEffect, useRef, DragEvent } from "react";
import { Email } from "@/lib/jmap/types";
import { IJMAPClient } from "@/lib/jmap/client-interface";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { useDragDropContext } from "@/contexts/drag-drop-context";
import { useUIStore } from "@/stores/ui-store";
import { isDragOutSupported } from "@/hooks/use-attachment-drag";

interface UseEmailDragOptions {
  email: Email;
  sourceMailboxId: string;
  threadEmails?: Email[];
}

interface UseEmailDragReturn {
  dragHandlers: {
    draggable: boolean;
    onPointerEnter?: () => void;
    onDragStart: (e: DragEvent<HTMLDivElement>) => void;
    onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  };
  isDragging: boolean;
}

function createDragPreview(count: number): HTMLElement {
  const preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.style.cssText = `
    position: fixed;
    top: -9999px;
    left: 0;
    padding: 8px 16px;
    background-color: var(--color-primary, #3b82f6);
    color: var(--color-primary-foreground, #ffffff);
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    font-size: 14px;
    font-weight: 500;
    z-index: 9999;
    white-space: nowrap;
    pointer-events: none;
  `;
  preview.textContent = count === 1 ? "1 email" : `${count} emails`;
  document.body.appendChild(preview);
  return preview;
}

function sanitizeFilenamePart(s: string, maxLen = 80): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[<>:"/\\|?*\x00-\x1F]+/g, "_").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, maxLen) || "";
}

function formatEmlDate(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "0000-00-00 00.00.00";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  );
}

function addressLabel(addr: { name?: string | null; email: string } | undefined, maxLen = 30): string {
  if (!addr) return "";
  const label = (addr.name && addr.name.trim()) || addr.email.split("@")[0] || addr.email;
  return sanitizeFilenamePart(label, maxLen);
}

function emlFilename(email: Email): string {
  const date = formatEmlDate(email.receivedAt || email.sentAt);
  const from = addressLabel(email.from?.[0]);
  const to = addressLabel(email.to?.[0]);
  const subject = sanitizeFilenamePart(email.subject || "no subject");
  return `${date} (${from}-${to}) ${subject}.eml`;
}

function bundleFilename(count: number): string {
  return `emails-${count}.zip`;
}

// Shared bundle cache. The .zip is keyed by the sorted list of email IDs in
// the selection, so two rows in the same selection reuse the same in-flight
// build. When the selection changes, the previous bundle URL is scheduled for
// revoke and a new build starts.
type BundleEntry = {
  key: string;
  name: string;
  url: string | null;
  promise: Promise<string | null> | null;
};

let currentBundle: BundleEntry | null = null;

function selectionKey(ids: string[]): string {
  return [...ids].sort().join(",");
}

async function buildEmailZip(client: IJMAPClient, emails: Email[]): Promise<string | null> {
  const eligible = emails.filter((em) => !!em.blobId);
  if (eligible.length === 0) return null;
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const used = new Set<string>();
  await Promise.all(
    eligible.map(async (em) => {
      const base = emlFilename(em).replace(/\.eml$/, "");
      let name = `${base}.eml`;
      while (used.has(name)) name = `${base} [${em.id.slice(0, 6)}].eml`;
      used.add(name);
      try {
        const blob = await client.fetchBlob(em.blobId!, name, "message/rfc822");
        zip.file(name, blob);
      } catch {
        // Skip individual failures; remaining messages still bundle.
      }
    }),
  );
  const zipBlob = await zip.generateAsync({ type: "blob", mimeType: "application/zip" });
  return URL.createObjectURL(zipBlob);
}

function prefetchEmailBundle(client: IJMAPClient, emails: Email[]): void {
  const key = selectionKey(emails.map((e) => e.id));
  if (currentBundle && currentBundle.key === key) return;
  if (currentBundle?.url) {
    const old = currentBundle.url;
    setTimeout(() => URL.revokeObjectURL(old), 60_000);
  }
  const entry: BundleEntry = {
    key,
    name: bundleFilename(emails.length),
    url: null,
    promise: null,
  };
  entry.promise = buildEmailZip(client, emails)
    .then((url) => {
      if (url && currentBundle === entry) entry.url = url;
      return url;
    })
    .catch(() => null);
  currentBundle = entry;
}

function getReadyBundle(emails: Email[]): { url: string; name: string } | null {
  const key = selectionKey(emails.map((e) => e.id));
  if (currentBundle && currentBundle.key === key && currentBundle.url) {
    return { url: currentBundle.url, name: currentBundle.name };
  }
  return null;
}

export function useEmailDrag({ email, sourceMailboxId, threadEmails }: UseEmailDragOptions): UseEmailDragReturn {
  const { selectedEmailIds, emails } = useEmailStore();
  const { startDrag, endDrag, isDragging, draggedEmails } = useDragDropContext();
  const isMobile = useUIStore((state) => state.isMobile);
  const client = useAuthStore((state) => state.client);

  const dragOutEnabled = !isMobile && isDragOutSupported() && !!client;
  const singleBlobUrlRef = useRef<string | null>(null);
  const inFlightRef = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    return () => {
      if (singleBlobUrlRef.current) {
        const url = singleBlobUrlRef.current;
        singleBlobUrlRef.current = null;
        // Defer revoke - Chromium asynchronously reads the blob: URL after the
        // drop completes, so revoking immediately can race the OS.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      inFlightRef.current = null;
    };
  }, [email.id]);

  const prefetchSingle = useCallback(() => {
    if (!dragOutEnabled || !client || !email.blobId) return;
    if (singleBlobUrlRef.current || inFlightRef.current) return;
    const name = emlFilename(email);
    inFlightRef.current = client
      .fetchBlobAsObjectUrl(email.blobId, name, "message/rfc822")
      .then((url) => {
        if (url && !singleBlobUrlRef.current) singleBlobUrlRef.current = url;
        return url;
      })
      .catch(() => null)
      .finally(() => {
        inFlightRef.current = null;
      });
  }, [dragOutEnabled, client, email]);

  const handlePointerEnter = useCallback(() => {
    if (!dragOutEnabled || !client) return;
    const isSelected = selectedEmailIds.has(email.id);
    const isMulti = isSelected && selectedEmailIds.size > 1;
    if (isMulti) {
      const selected = emails.filter((em) => selectedEmailIds.has(em.id));
      // Only worth bundling when at least one selected email has a blobId.
      if (selected.some((em) => em.blobId)) {
        prefetchEmailBundle(client, selected);
      }
    } else {
      prefetchSingle();
    }
  }, [dragOutEnabled, client, selectedEmailIds, email.id, emails, prefetchSingle]);

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>) => {
    // Determine which emails to drag:
    // - If current email is selected, drag all selected
    // - If threadEmails provided (thread header), drag all thread emails
    // - Otherwise, drag only this email
    const isSelected = selectedEmailIds.has(email.id);
    const emailsToDrag = isSelected
      ? emails.filter(em => selectedEmailIds.has(em.id))
      : threadEmails || [email];

    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(
      "application/x-email-ids",
      JSON.stringify(emailsToDrag.map(em => em.id))
    );
    e.dataTransfer.setData(
      "text/plain",
      emailsToDrag.map(em => em.subject || "(no subject)").join(", ")
    );

    // Drag-out to file explorer.
    if (dragOutEnabled && client) {
      if (emailsToDrag.length === 1 && emailsToDrag[0].blobId) {
        const url = singleBlobUrlRef.current;
        if (url) {
          const name = emlFilename(emailsToDrag[0]);
          // `DownloadURL` format: <mime>:<filename>:<url>. Chromium reads this
          // on drop and writes a real file; Firefox/Safari ignore it.
          e.dataTransfer.setData(
            "DownloadURL",
            `message/rfc822:${encodeURIComponent(name)}:${url}`,
          );
        } else {
          // Not warmed up yet — kick off so the next attempt works. Don't
          // preventDefault: in-app drop still has to function.
          prefetchSingle();
        }
      } else if (emailsToDrag.length > 1) {
        const ready = getReadyBundle(emailsToDrag);
        if (ready) {
          e.dataTransfer.setData(
            "DownloadURL",
            `application/zip:${encodeURIComponent(ready.name)}:${ready.url}`,
          );
        } else {
          // Kick off the bundle build for the next attempt.
          prefetchEmailBundle(client, emailsToDrag);
        }
      }
    }

    // Create custom drag image
    const dragPreview = createDragPreview(emailsToDrag.length);
    e.dataTransfer.setDragImage(dragPreview, 0, 0);

    // Clean up preview after drag starts (browser keeps a snapshot)
    requestAnimationFrame(() => {
      dragPreview.remove();
    });

    startDrag(emailsToDrag, sourceMailboxId);
  }, [email, selectedEmailIds, emails, sourceMailboxId, startDrag, threadEmails, dragOutEnabled, client, prefetchSingle]);

  const handleDragEnd = useCallback(() => {
    endDrag();
    // Defer-revoke the per-row single .eml URL. The shared bundle URL stays
    // cached until the selection changes - revoking it here would break a
    // subsequent drag of the same selection.
    if (singleBlobUrlRef.current) {
      const url = singleBlobUrlRef.current;
      singleBlobUrlRef.current = null;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }, [endDrag]);

  // Check if this specific email is being dragged
  const isThisEmailDragging = isDragging && draggedEmails.some(em => em.id === email.id);

  return {
    dragHandlers: isMobile
      ? { draggable: false, onDragStart: () => {}, onDragEnd: () => {} }
      : {
          draggable: true,
          onPointerEnter: dragOutEnabled ? handlePointerEnter : undefined,
          onDragStart: handleDragStart,
          onDragEnd: handleDragEnd,
        },
    isDragging: isThisEmailDragging,
  };
}
