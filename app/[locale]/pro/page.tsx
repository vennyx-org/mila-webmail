"use client";

import { useEffect, useMemo, useState, type ComponentType, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { EmbeddedContext } from "@/hooks/use-is-embedded";
import { ProTabBar, PRO_TAB_DRAG_MIME } from "@/components/pro/pro-tab-bar";
import { useProTabStore, type ProTab, type ProTabKind, type ProPaneId } from "@/stores/pro-tab-store";
import { cn } from "@/lib/utils";

import MailPage from "@/app/[locale]/page";
import CalendarPage from "@/app/[locale]/calendar/page";
import ContactsPage from "@/app/[locale]/contacts/page";
import FilesPage from "@/app/[locale]/files/page";
import SettingsPage from "@/app/[locale]/settings/page";
import { ProComposeTabBody } from "@/components/pro/pro-compose-tab-body";
import { ProEmailTabBody } from "@/components/pro/pro-email-tab-body";

const APP_TAB_COMPONENTS: Partial<Record<ProTabKind, ComponentType>> = {
  mail: MailPage,
  calendar: CalendarPage,
  contacts: ContactsPage,
  files: FilesPage,
  settings: SettingsPage,
};

type DropTarget = 'left' | 'right' | 'top' | 'bottom' | null;

function renderTabBody(tab: ProTab): React.ReactNode {
  if (tab.kind === 'compose' && tab.composeData) {
    return <ProComposeTabBody tabId={tab.id} data={tab.composeData} />;
  }
  if (tab.kind === 'email' && tab.emailData) {
    return <ProEmailTabBody tabId={tab.id} data={tab.emailData} />;
  }
  const Component = APP_TAB_COMPONENTS[tab.kind];
  return Component ? <Component /> : null;
}

interface PaneProps {
  paneId: ProPaneId;
  tabs: ProTab[];
  activeTabId: string | null;
  loadedTabIds: string[];
  onPaneFocus: (paneId: ProPaneId) => void;
  isFocused: boolean;
}

function Pane({ paneId, tabs, activeTabId, loadedTabIds, onPaneFocus, isFocused }: PaneProps) {
  return (
    <div
      className="relative flex flex-1 flex-col overflow-hidden min-w-0 min-h-0"
      onMouseDownCapture={() => { if (!isFocused) onPaneFocus(paneId); }}
    >
      {tabs
        .filter((tab) => loadedTabIds.includes(tab.id))
        .map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={cn("absolute inset-0 overflow-hidden", !isActive && "hidden")}
              aria-hidden={!isActive}
            >
              {renderTabBody(tab)}
            </div>
          );
        })}
    </div>
  );
}

export default function ProHome() {
  const t = useTranslations();
  const { isMobile, isTablet, isDesktop } = useDeviceDetection();

  const [initialCheckDone, setInitialCheckDone] = useState(
    () => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client
  );
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const {
    showAppsModal,
    inlineApp,
    loadedApps,
    handleManageApps,
    handleInlineApp,
    closeInlineApp,
    closeAppsModal,
  } = useSidebarApps();

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);
  const logout = useAuthStore((s) => s.logout);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const authLoading = useAuthStore((s) => s.isLoading);
  const quota = useEmailStore((s) => s.quota);
  const isPushConnected = useEmailStore((s) => s.isPushConnected);

  const tabs = useProTabStore((s) => s.tabs);
  const activeMainTabId = useProTabStore((s) => s.activeTabId);
  const activeSplitTabId = useProTabStore((s) => s.activeSplitTabId);
  const splitOrientation = useProTabStore((s) => s.splitOrientation);
  const focusedPaneId = useProTabStore((s) => s.focusedPaneId);
  const loadedTabIds = useProTabStore((s) => s.loadedTabIds);
  const openTab = useProTabStore((s) => s.openTab);
  const closeTab = useProTabStore((s) => s.closeTab);
  const setActiveTab = useProTabStore((s) => s.setActiveTab);
  const setFocusedPane = useProTabStore((s) => s.setFocusedPane);
  const moveTabToPane = useProTabStore((s) => s.moveTabToPane);

  const [isTabDragging, setIsTabDragging] = useState(false);
  const [splitDropTarget, setSplitDropTarget] = useState<DropTarget>(null);
  /** Whether the split pane visually renders before (true) or after (false) main. */
  const [splitLeading, setSplitLeading] = useState(false);

  // Auth bootstrap (mirrors standard page)
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  useEffect(() => {
    if (initialCheckDone && (isMobile || isTablet) && typeof window !== "undefined") {
      window.location.replace("/");
    }
  }, [initialCheckDone, isMobile, isTablet]);

  const mainTabs = useMemo(() => tabs.filter((t) => t.paneId === 'main'), [tabs]);
  const splitTabs = useMemo(() => tabs.filter((t) => t.paneId === 'split'), [tabs]);

  const focusedActiveTab = useMemo(() => {
    const id = focusedPaneId === 'main' ? activeMainTabId : activeSplitTabId;
    return tabs.find((t) => t.id === id) ?? null;
  }, [tabs, focusedPaneId, activeMainTabId, activeSplitTabId]);

  const handleRailNavigate = (itemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => {
    openTab(itemId);
    return true;
  };

  const railActiveItemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings' | null =
    focusedActiveTab && (
      focusedActiveTab.kind === 'mail' || focusedActiveTab.kind === 'calendar'
      || focusedActiveTab.kind === 'contacts' || focusedActiveTab.kind === 'files'
      || focusedActiveTab.kind === 'settings'
    ) ? focusedActiveTab.kind : null;

  const isSplit = splitOrientation !== null && splitTabs.length > 0;

  // ---- Body-level drop targets ----

  const isProTabDrag = (e: DragEvent) => e.dataTransfer.types.includes(PRO_TAB_DRAG_MIME);

  const computeDropTarget = (e: DragEvent<HTMLDivElement>): DropTarget => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const xFrac = x / rect.width;
    const yFrac = y / rect.height;

    if (isSplit) {
      // When split: each pane gets half the body as its drop zone.
      if (splitOrientation === 'vertical') {
        return xFrac < 0.5 ? 'left' : 'right';
      }
      return yFrac < 0.5 ? 'top' : 'bottom';
    }
    // No split: only the outer 22% of each edge creates a split.
    const fromLeft = xFrac;
    const fromRight = 1 - xFrac;
    const fromTop = yFrac;
    const fromBottom = 1 - yFrac;
    const min = Math.min(fromLeft, fromRight, fromTop, fromBottom);
    if (min > 0.22) return null;
    if (min === fromRight) return 'right';
    if (min === fromLeft) return 'left';
    if (min === fromBottom) return 'bottom';
    return 'top';
  };

  const targetPaneFromDrop = (target: DropTarget): ProPaneId | null => {
    if (!target || !isSplit) return null;
    if (splitOrientation === 'vertical') {
      const leftIsSplit = splitLeading;
      if (target === 'left') return leftIsSplit ? 'split' : 'main';
      if (target === 'right') return leftIsSplit ? 'main' : 'split';
    }
    if (splitOrientation === 'horizontal') {
      const topIsSplit = splitLeading;
      if (target === 'top') return topIsSplit ? 'split' : 'main';
      if (target === 'bottom') return topIsSplit ? 'main' : 'split';
    }
    return null;
  };

  const handleBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const next = computeDropTarget(e);
    if (next !== splitDropTarget) setSplitDropTarget(next);
  };

  const handleBodyDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setSplitDropTarget(null);
  };

  const handleBodyDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    const target = computeDropTarget(e);
    setSplitDropTarget(null);
    setIsTabDragging(false);
    if (!target) return;
    e.preventDefault();
    const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
    if (!draggedId) return;

    if (isSplit) {
      // Move tab to whichever pane occupies the dropped side.
      const destPane = targetPaneFromDrop(target);
      if (destPane) moveTabToPane(draggedId, destPane);
      return;
    }
    // Create a new split.
    const orientation = (target === 'left' || target === 'right') ? 'vertical' : 'horizontal';
    moveTabToPane(draggedId, 'split', orientation);
    setSplitLeading(target === 'left' || target === 'top');
  };

  // Loading state (matches standard page exactly)
  if (!initialCheckDone || authLoading || !isAuthenticated || !client) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto"></div>
          <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  if (!isDesktop) return null;

  const mainPane = (
    <Pane
      paneId="main"
      tabs={mainTabs}
      activeTabId={activeMainTabId}
      loadedTabIds={loadedTabIds}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'main'}
    />
  );

  const splitPane = isSplit ? (
    <Pane
      paneId="split"
      tabs={splitTabs}
      activeTabId={activeSplitTabId}
      loadedTabIds={loadedTabIds}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'split'}
    />
  ) : null;

  const splitDivider = isSplit ? (
    <div
      aria-hidden="true"
      className={cn(
        "flex-shrink-0 bg-transparent",
        splitOrientation === 'vertical' ? "w-px" : "h-px",
      )}
      style={
        splitOrientation === 'vertical'
          ? { borderLeft: '1px solid rgba(128, 128, 128, 0.3)' }
          : { borderTop: '1px solid rgba(128, 128, 128, 0.3)' }
      }
    />
  ) : null;

  // Drop-zone overlays: 4 edges when not split, 2 panes when split.
  const dropZones = isTabDragging ? (
    <>
      {!isSplit && (
        <>
          <DropZone active={splitDropTarget === 'left'} side="left" />
          <DropZone active={splitDropTarget === 'right'} side="right" />
          <DropZone active={splitDropTarget === 'top'} side="top" />
          <DropZone active={splitDropTarget === 'bottom'} side="bottom" />
        </>
      )}
      {isSplit && splitOrientation === 'vertical' && (
        <>
          <DropZoneHalf active={splitDropTarget === 'left'} axis="x" side="leading" />
          <DropZoneHalf active={splitDropTarget === 'right'} axis="x" side="trailing" />
        </>
      )}
      {isSplit && splitOrientation === 'horizontal' && (
        <>
          <DropZoneHalf active={splitDropTarget === 'top'} axis="y" side="leading" />
          <DropZoneHalf active={splitDropTarget === 'bottom'} axis="y" side="trailing" />
        </>
      )}
    </>
  ) : null;

  return (
    <EmbeddedContext.Provider value={true}>
      <div className="flex flex-col h-dvh bg-background overflow-hidden pt-[env(safe-area-inset-top)]">
        <div className="flex flex-1 overflow-hidden">
          {/* Leftmost Navigation Rail — identical to the standard layout */}
          <div
            className="w-14 bg-secondary flex flex-col flex-shrink-0"
            style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}
          >
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={logout}
              onShowShortcuts={() => setShowShortcutsModal(true)}
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
              onNavigate={handleRailNavigate}
              activeItemId={railActiveItemId}
            />
          </div>

          {inlineApp && (
            <InlineAppView
              apps={loadedApps}
              activeAppId={inlineApp.id}
              onClose={closeInlineApp}
              className="flex-1"
            />
          )}

          {!inlineApp && (
            <div className="flex flex-1 flex-col overflow-hidden min-w-0">
              {/* Single, unified tab bar above both panes. */}
              <ProTabBar
                tabs={tabs}
                activeMainTabId={activeMainTabId}
                activeSplitTabId={activeSplitTabId}
                onActivate={setActiveTab}
                onClose={closeTab}
                onDragStateChange={setIsTabDragging}
              />

              {/* Panes container — accepts body drops for split/move. */}
              <div
                className={cn(
                  "relative flex flex-1 overflow-hidden min-w-0",
                  isSplit && splitOrientation === 'horizontal' ? "flex-col" : "flex-row",
                )}
                onDragOver={handleBodyDragOver}
                onDragLeave={handleBodyDragLeave}
                onDrop={handleBodyDrop}
              >
                {isSplit
                  ? (splitLeading
                      ? <>{splitPane}{splitDivider}{mainPane}</>
                      : <>{mainPane}{splitDivider}{splitPane}</>)
                  : mainPane}

                {dropZones}
              </div>
            </div>
          )}
        </div>

        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />
        {showAppsModal && (
          <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        )}
      </div>
    </EmbeddedContext.Provider>
  );
}

function DropZone({ active, side }: { active: boolean; side: 'left' | 'right' | 'top' | 'bottom' }) {
  const isVertical = side === 'left' || side === 'right';
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 transition-colors duration-100",
        isVertical ? "top-0 bottom-0 w-[22%]" : "left-0 right-0 h-[22%]",
        side === 'left' && "left-0",
        side === 'right' && "right-0",
        side === 'top' && "top-0",
        side === 'bottom' && "bottom-0",
        active ? "bg-primary/15 ring-2 ring-primary/40 ring-inset" : "bg-transparent",
      )}
    />
  );
}

function DropZoneHalf({ active, axis, side }: { active: boolean; axis: 'x' | 'y'; side: 'leading' | 'trailing' }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute z-10 transition-colors duration-100",
        axis === 'x'
          ? cn("top-0 bottom-0 w-1/2", side === 'leading' ? "left-0" : "right-0")
          : cn("left-0 right-0 h-1/2", side === 'leading' ? "top-0" : "bottom-0"),
        active ? "bg-primary/10 ring-2 ring-primary/40 ring-inset" : "bg-transparent",
      )}
    />
  );
}
