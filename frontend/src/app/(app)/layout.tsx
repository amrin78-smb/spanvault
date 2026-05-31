import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';
import AlertBanner from '@/components/AlertBanner';

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
    </>
  );
}
