import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import AlertBanner from '@/components/AlertBanner';
import GlobalSearch from '@/components/GlobalSearch';
import IdleTimeout from '@/components/IdleTimeout';
import KeyboardShortcuts from '@/components/KeyboardShortcuts';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AlertBanner />
      <div className="sv-shell">
        <Sidebar />
        <div className="sv-main">
          <TopBar />
          <main className="sv-content">{children}</main>
        </div>
      </div>
      <GlobalSearch />
      <IdleTimeout />
      <KeyboardShortcuts />
    </>
  );
}
