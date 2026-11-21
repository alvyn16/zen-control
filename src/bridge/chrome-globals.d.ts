/**
 * Globals visible to the bridge bundle when it is loaded into Zen's browser
 * chrome with `Services.scriptloader.loadSubScript`. These are privileged
 * Firefox/Zen APIs; `any` is intentional here and only in this declaration
 * file. Everything else in the codebase stays strictly typed.
 */

declare const Services: any;
declare const Components: any;
declare const ChromeUtils: any;
declare const ContextualIdentityService: any;
declare const PlacesUtils: any;
declare const SessionStore: any;
declare const gBrowser: any;
declare const gZenWorkspaces: any;
declare const gZenFolders: any;
declare const gZenPinnedTabManager: any;
declare const gZenViewSplitter: any;
declare const gZenGlanceManager: any;
declare const gZenStartup: any;
declare const gZenUIManager: any;

interface Window {
  __zenMcpConfig?: {
    url: string;
    token: string;
    bridgeVersion: string;
    serverVersion: string;
  };
  __zenMcpBridge?: {
    version: string;
    token: string;
    windowId: string;
    isConnected(): boolean;
    reconnect(): void;
    destroy(): void;
  };
  __zenMcpWindowId?: string;
  Services: any;
  ChromeUtils: any;
  Components: any;
  gBrowser: any;
  gZenWorkspaces: any;
  gZenFolders: any;
  gZenPinnedTabManager: any;
  gZenViewSplitter: any;
  gZenGlanceManager: any;
  gZenStartup: any;
  PlacesUtils: any;
  ContextualIdentityService: any;
  SessionStore: any;
}
