import Sidebar from '@/components/Sidebar';
import TopBar from '@/components/TopBar';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sv-shell">
      <Sidebar />
      <div className="sv-main">
        <TopBar />
        <main className="sv-content">{children}</main>
      </div>
    </div>
  );
}
