// Process-wide queue for plugin-requested host dialogs (confirm / alert).
// The sandboxed plugin posts a `ui.confirm` API request; the host enqueues a
// dialog here and resolves the awaited Promise after the user clicks. The
// `PluginDialogHost` component subscribes and renders one dialog at a time.

export type DialogKind = 'confirm' | 'alert';

export interface DialogRequest {
  id: string;
  pluginId: string;
  kind: DialogKind;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, confirm button uses destructive styling. */
  danger?: boolean;
  /** Called when the dialog closes. `ok` is true only for confirm-accept. */
  resolve: (ok: boolean) => void;
}

const queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function enqueueDialog(req: Omit<DialogRequest, 'id'>): { id: string } {
  const entry: DialogRequest = { ...req, id: uid() };
  queue.push(entry);
  notify();
  return { id: entry.id };
}

export function head(): DialogRequest | null {
  return queue[0] ?? null;
}

export function resolveHead(ok: boolean): void {
  const entry = queue.shift();
  if (!entry) return;
  try { entry.resolve(ok); } catch { /* ignore */ }
  notify();
}

/** Cancel every pending dialog for a plugin (called on unload). */
export function cancelForPlugin(pluginId: string): void {
  let changed = false;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].pluginId === pluginId) {
      const entry = queue[i];
      queue.splice(i, 1);
      try { entry.resolve(false); } catch { /* ignore */ }
      changed = true;
    }
  }
  if (changed) notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Internal helper used by host-api to convert an `enqueueDialog` call into a
 * Promise the plugin-side `await` can land on.
 */
export function awaitDialog(req: Omit<DialogRequest, 'id' | 'resolve'>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueueDialog({ ...req, resolve });
  });
}
