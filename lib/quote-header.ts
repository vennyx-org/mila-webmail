// Builds the default reply/forward quote header and runs it through the
// emailHooks.onBuildQuoteHeader transform so plugins can replace it (e.g.
// with an Outlook-style From/Sent/To/Cc/Subject block).
//
// This module is the single source of truth for the default header strings -
// the composer keeps the same defaults inline as a fallback, but production
// flow goes through here.

import { formatDateTime } from "@/lib/utils";
import { emailHooks } from "@/lib/plugin-hooks";
import type { QuoteHeader, QuoteHeaderContext } from "@/lib/plugin-types";

interface BuildArgs {
  mode: "reply" | "replyAll" | "forward";
  email: {
    from?: { email?: string; name?: string }[];
    to?: { email?: string; name?: string }[];
    cc?: { email?: string; name?: string }[];
    subject?: string;
    receivedAt?: string;
  };
  newTo: string[];
  newCc: string[];
  locale: string;
  timeFormat: "12h" | "24h";
  unknownLabel: string;
}

function defaultHeader(args: BuildArgs): QuoteHeader {
  const { mode, email, timeFormat, unknownLabel } = args;
  const date = email.receivedAt
    ? formatDateTime(email.receivedAt, timeFormat, {
        weekday: "short",
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";
  const from = email.from?.[0];
  const fromStr = from ? `${from.name || from.email}` : unknownLabel;
  const subject = email.subject || "";

  if (mode === "forward") {
    const text = `---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${date}\nSubject: ${subject}\n`;
    const html = `<div>---------- Forwarded message ----------<br>From: ${fromStr}<br>Date: ${date}<br>Subject: ${subject}<br><br></div>`;
    return { html, text, wrapInBlockquote: false };
  }

  const text = `On ${date}, ${fromStr} wrote:\n`;
  const html = `<div>On ${date}, ${fromStr} wrote:<br></div>`;
  return { html, text, wrapInBlockquote: true };
}

export async function buildQuoteHeader(args: BuildArgs): Promise<QuoteHeader> {
  const def = defaultHeader(args);
  const ctx: QuoteHeaderContext = {
    mode: args.mode,
    newTo: args.newTo,
    newCc: args.newCc,
    from: args.email.from?.[0]?.email
      ? { name: args.email.from[0].name, email: args.email.from[0].email }
      : null,
    to: (args.email.to ?? [])
      .filter((r): r is { email: string; name?: string } => !!r.email)
      .map((r) => ({ name: r.name, email: r.email })),
    cc: (args.email.cc ?? [])
      .filter((r): r is { email: string; name?: string } => !!r.email)
      .map((r) => ({ name: r.name, email: r.email })),
    subject: args.email.subject ?? "",
    date: args.email.receivedAt
      ? formatDateTime(args.email.receivedAt, args.timeFormat, {
          weekday: "short",
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "",
    receivedAt: args.email.receivedAt,
    locale: args.locale,
  };
  return emailHooks.onBuildQuoteHeader.transform<QuoteHeader>(def, ctx);
}
