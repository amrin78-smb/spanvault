import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import AlertBanner from '@/components/AlertBanner';
import GlobalSearch from '@/components/GlobalSearch';
import IdleTimeout from '@/components/IdleTimeout';
import KeyboardShortcuts from '@/components/KeyboardShortcuts';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Full-height column: header spans the full page width (over the
          sidebar); below it a flex row holds the sidebar + scrolling content. */}
      <div className="sv-shell">
        <TopBar />
        <AlertBanner />
        <div className="sv-body">
          <Sidebar />
          <main className="sv-content">{children}</main>
        </div>
      </div>
      <GlobalSearch />
      <IdleTimeout />
      <KeyboardShortcuts />
    </>
  );
}
