import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import AlertBanner from '@/components/AlertBanner';
import UpdateNotifier from '@/components/UpdateNotifier';
import GlobalSearch from '@/components/GlobalSearch';
import IdleTimeout from '@/components/IdleTimeout';
import KeyboardShortcuts from '@/components/KeyboardShortcuts';
import { LicenseBanner } from '@/components/LicenseGuard';

// LicenseProvider + LicenseGate now live in the ROOT layout (src/app/layout.tsx)
// so the full-screen license lock covers EVERY route, not just the (app) group.
// This layout only renders the in-shell LicenseBanner; useLicense() still
// resolves via the provider mounted at the root.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Full-height column: header spans the full page width (over the
          sidebar); below it a flex row holds the sidebar + scrolling content. */}
      <div className="sv-shell">
        <TopBar />
        <div className="sv-body">
          <Sidebar />
          {/* Content column — banners live here so they span only the content
              width (not the full screen over the sidebar), matching the suite. */}
          <div className="sv-content-col">
            <AlertBanner />
            <LicenseBanner />
            <UpdateNotifier />
            <main className="sv-content">{children}</main>
          </div>
        </div>
      </div>
      <GlobalSearch />
      <IdleTimeout />
      <KeyboardShortcuts />
    </>
  );
}
